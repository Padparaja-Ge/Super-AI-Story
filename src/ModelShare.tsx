import {useEffect, useState} from 'react';
import {Copy, Link2, Share2, Square} from 'lucide-react';
import {api, copyText} from './api';
import {t, uiLocale} from './i18n';
import {Button, Field, Spinner} from './UI';
import type {StudioProps} from './types';
import './ModelShare.css';

type ShareStatus = {
  state: 'stopped' | 'starting' | 'running' | 'stopping';
  interfaces: {address: string; name: string}[];
  connections: {id: string; name: string; model: string}[];
  address?: string;
  port?: number;
  guestAddress?: string;
  model?: string;
  expiresAt?: number;
  active?: boolean;
  remaining?: number;
};

type ShareProps = Pick<StudioProps, 'flush' | 'refresh' | 'notify'> & {
  onConnected: (id: string) => void;
};

export function ModelShare({flush, refresh, notify, onConnected}: ShareProps) {
  const [status, setStatus] = useState<ShareStatus>();
  const [connection, setConnection] = useState('');
  const [address, setAddress] = useState('127.0.0.1');
  const [guestAddress, setGuestAddress] = useState('');
  const [minutes, setMinutes] = useState(30);
  const [invitation, setInvitation] = useState('');
  const [visibleInvite, setVisibleInvite] = useState('');
  const [busy, setBusy] = useState<'start' | 'stop' | 'copy' | 'join' | ''>('');
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const selected = status?.connections.find(item => item.id === connection)?.id || status?.connections[0]?.id || '';
  const active = status?.state === 'running';
  const waiting = status?.state === 'starting' || status?.state === 'stopping';
  const canStop = active || status?.state === 'starting';
  const remote = address !== '127.0.0.1';
  const expiry = status?.expiresAt ? new Intl.DateTimeFormat(uiLocale(), {timeStyle: 'short'}).format(status.expiresAt) : '';
  const actionableInvite = invitation.trim().length > 0 && invitation.trim().length <= 512;

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const next = await api<ShareStatus>('/model-share/status');
        if (alive) {
          setStatus(next);
          setFailure('');
          if (next.state !== 'running') setVisibleInvite('');
        }
      } catch (cause) {
        if (alive) setFailure((cause as Error).message);
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  async function operate(action: Exclude<typeof busy, ''>) {
    setBusy(action);
    setNotice('');
    try {
      if (action === 'start') {
        await flush();
        setVisibleInvite('');
        setStatus(await api<ShareStatus>('/model-share/start', { connectionId: selected, address, guestAddress: guestAddress.trim(), minutes }));
      } else if (action === 'stop') {
        setStatus(await api<ShareStatus>('/model-share/stop', {}));
        setVisibleInvite('');
      } else if (action === 'copy') {
        const result = await api<{invitation: string}>('/model-share/invitation', {});
        try {
          await copyText(result.invitation);
          setNotice(t('Приглашение скопировано.'));
        } catch { setVisibleInvite(result.invitation); }
      } else {
        await flush();
        const result = await api<{connectionId: string}>('/model-share/join', { invitation: invitation.trim() });
        setInvitation('');
        await refresh();
        onConnected(result.connectionId);
        notify(t('Общая модель подключена и выбрана.'));
      }
    } catch (cause) {
      notify(t((cause as Error).message), true);
    } finally {
      setBusy('');
    }
  }

  return <>
    {failure && <p className="error-box" role="alert">{t(failure)}</p>}
    <div className="model-share">
      <section className="panel model-share-panel" aria-labelledby="model-share-host">
        <div className="panel-heading model-share-heading">
          <h2 id="model-share-host"><Share2 size={20} aria-hidden="true"/>{t('Поделиться моделью')}</h2>
          {!failure && <span className={'badge' + (active ? ' positive' : '')} role="status">
            {t(active ? 'Сеанс открыт' : waiting ? 'Подготовка сеанса…' : 'Сеанс закрыт')}
          </span>}
        </div>
        {active && status ? <>
          <dl className="model-share-status">
            <dt>{t('Модель')}</dt><dd>{status.model}</dd>
            <dt>{t('Адрес сервера')}</dt><dd>{status.address}:{status.port}</dd>
            <dt>{t('Адрес получателя')}</dt><dd>{status.guestAddress}</dd>
            <dt>{t('Действует до')}</dt><dd>{expiry}</dd>
            <dt>{t('Осталось запросов')}</dt><dd>{status.remaining}</dd>
          </dl>
          <p className="muted small">{t(status.active ? 'Модель отвечает получателю.' : 'Приглашение действует для одного адреса. Передайте его другу лично.')}</p>
          {visibleInvite && <Field label={t('Скопируйте приглашение вручную')}>
            <textarea rows={3} readOnly value={visibleInvite} onFocus={event => event.target.select()}/>
          </Field>}
          <div className="model-share-actions">
            <Button primary disabled={!!busy} onClick={() => void operate('copy')}>
              {busy === 'copy' ? <Spinner/> : <Copy size={16}/>} {t('Копировать приглашение')}
            </Button>
            <Button danger disabled={busy === 'stop'} onClick={() => void operate('stop')}><Square size={15}/> {t('Закрыть сеанс')}</Button>
          </div>
        </> : <>
          <p className="muted small">{t('Друг сможет генерировать текст вашей запущенной моделью через локальную сеть или доверенный VPN.')}</p>
          <Field label={t('Модель владельца')}>
            <select value={selected} disabled={waiting || !!busy} onChange={event => setConnection(event.target.value)}>
              {!selected && <option value="">{t('Сначала выберите и запустите локальную модель')}</option>}
              {status?.connections.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}
            </select>
          </Field>
          <Field label={t('Сетевой адаптер')}>
            <select value={address} disabled={waiting || !!busy} onChange={event => setAddress(event.target.value)}>
              {(status?.interfaces || [{name: 'Loopback', address: '127.0.0.1'}]).map(item =>
                <option key={item.address} value={item.address}>
                  {item.address === '127.0.0.1' ? t('Этот компьютер') : item.name} · {item.address}
                </option>)}
            </select>
          </Field>
          {remote && <Field label={t('IPv4 друга')} hint={t('Укажите адрес друга в той же сети или VPN. Открывайте сеанс только в доверенной сети. HTTP не шифрует текст и ключ.')}>
            <input value={guestAddress} disabled={waiting || !!busy} onChange={event => setGuestAddress(event.target.value)}
              placeholder="192.168.1.24" maxLength={15} autoComplete="off" spellCheck={false}/>
          </Field>}
          <Field label={t('Длительность сеанса')}>
            <select value={minutes} disabled={waiting || !!busy} onChange={event => setMinutes(Number(event.target.value))}>
              {[15, 30, 60, 120].map(value => <option key={value} value={value}>{t('{0} мин', [value])}</option>)}
            </select>
          </Field>
          <div className="model-share-actions">
            <Button primary disabled={!selected || !!busy || waiting || remote && !guestAddress.trim()} onClick={() => void operate('start')}>
              {busy === 'start' || waiting ? <Spinner/> : <Share2 size={16}/>} {t('Открыть сеанс')}
            </Button>
            {canStop && <Button danger disabled={busy === 'stop'} onClick={() => void operate('stop')}><Square size={15}/> {t('Закрыть сеанс')}</Button>}
          </div>
        </>}
      </section>
      <section className="panel model-share-panel" aria-labelledby="model-share-guest">
        <div className="panel-heading model-share-heading">
          <h2 id="model-share-guest"><Link2 size={20} aria-hidden="true"/>{t('Подключиться по приглашению')}</h2>
        </div>
        <p className="muted small">{t('Общую модель можно выбрать для обычной истории, большой комнаты, D&D и фанфика. Текст запроса с нужными фрагментами контекста передаётся на компьютер владельца.')}</p>
        <Field label={t('Приглашение на генерацию')} hint={t('Вставьте код от друга. После перезапуска SAS задайте приглашение снова.')}>
          <input type="password" value={invitation} maxLength={512} onChange={event => setInvitation(event.target.value)}
            autoComplete="off" spellCheck={false} placeholder="SAS-SHARE-1.…"/>
        </Field>
        <div className="model-share-actions">
          <Button primary disabled={!actionableInvite || !!busy} onClick={() => void operate('join')}>
            {busy === 'join' ? <Spinner/> : <Link2 size={16}/>} {t('Подключить и выбрать модель')}
          </Button>
        </div>
      </section>
    </div>
    {notice && <p className="muted small" role="status">{notice}</p>}
  </>;
}
