const entry = (id,cast,name,content,keys,englishName,englishContent) => ({
  id, cast, name, content, keys, priority:25, reference:{name:englishName,content:englishContent}
});

export const fanficSupportLore = {
  school: [
    entry('hospital-family',['wasuke'],'Больница, Васукэ и семейные границы',
      'Васукэ — дед Юдзи, который находится в больнице около начала этой ветки. Юдзи может помнить отдельные слова, а медперсонал — подтвердить время посещения. Дед не видел школьную реликвию и не может объяснять план Мэгуми. Уход из больницы, последний разговор и судьба Васукэ определяются выбранной веткой. Привяжи обещания Юдзи к тому, что он действительно услышал, и оставь ему право решить, кому рассказать о семье.',
      ['дед Юдзи', 'больничный визит', 'семейное обещание', 'Yuji’s grandfather', "Yuji's grandfather", 'hospital visit'],
      'The hospital, Wasuke, and family boundaries',
      'Wasuke is Yuji’s grandfather and is in hospital around the opening. Yuji may remember something he said, and staff can verify the time of a visit. Wasuke did not see the school relic and cannot explain Megumi’s plan. The final conversation and Wasuke’s condition follow from this branch. Tie Yuji’s promises to words he actually heard and let him choose whom to tell.'),
    entry('school-and-report',['takagi','ijichi'],'Такаги, Идзити и разрыв между школами',
      'Такаги знает расписание школы, учителей и доступные спортзалы. Он может взять школьников под присмотр и подтвердить, когда Юдзи был в здании. Идзити знает порядок работы школы магов. Мэгуми может связать их сведения докладом или встречей, на которой каждый говорит только о своём участке. Если закрыли основной выход, Такаги может предложить путь, а Идзити организовать безопасную передачу людей или улик после получения адреса.',
      ['доступ в спортзал', 'передача улик', 'школьный учитель', 'gym access', 'coordination call', 'evidence handoff'],
      'Takagi, Ijichi, and the gap between the schools',
      'Takagi knows the school schedule, staff, and accessible facilities. He can look after students and confirm when Yuji was in the building. Ijichi knows how Jujutsu High handles an incident. Megumi can connect their knowledge through a report or meeting where each speaks for their own area. If the main exit is blocked, Takagi can suggest a route and Ijichi can arrange a handoff once the address is confirmed.')
  ],
  'night-city': [
    entry('network-and-extraction',['kiwi','falco'],'Киви, Фалько и цена безопасного выхода',
      'Киви может проверить происхождение записи, если получила доступ к устройству или копии данных. Она не узнаёт, кто ждёт у ячейки, по одному идентификатору. Фалько может подтвердить доступную дорогу и время вывоза после согласия на работу. Один безопасный маршрут не доказывает подлинности заказа. Люси вправе доверить Киви только часть записи, а звонок Фалько может открыть одну возможность и закрыть другую по времени.',
      ['почерк нетраннера', 'маршрут эвакуации', 'резервная машина', 'backup driver', 'escape route', 'verify the manifest'],
      'Kiwi, Falco, and the price of a way out',
      'Kiwi can check where a record came from if given access to a device or a copy. One identifier cannot tell her who is waiting at the locker. Falco can confirm a route and pickup time after accepting the job. A safe route does not validate the contract. Lucy can share only part of a record, and asking Falco for a pickup can open one option while closing another on time.'),
    entry('two-tanakas',['tanaka'],'Два Танаки и закрытые полномочия',
      'Кацуо знает обстановку в классе и школьный конфликт. Танака-старший располагает служебным доступом и может прочитать зарегистрированные сведения, если найдёт номер записи. Родство не даёт им общей памяти. При попытке связать отца с имплантом отделяй школьный рапорт, корпоративный заказ и владение предметом. Даже официальное письмо не раскрывает содержимое закрытого груза без независимого подтверждения.',
      ['отец Кацуо', 'служебный доступ Танаки', 'школьный рапорт', 'corporate record', 'academy incident report', 'implant order'],
      'The two Tanakas and restricted clearance',
      'Katsuo knows the classroom conflict. Tanaka senior has corporate clearance and can inspect a registered record if he finds its number. Being related does not give them shared knowledge. When tracing the implant, distinguish the school report, the corporate order, and physical possession. An official message does not establish what is inside a sealed shipment.')
  ],
  iceland: [
    entry('ragnar-and-canute',['ragnar'],'Рагнар, Кнуд и письмо с другого берега',
      'Рагнар защищает Кнуда и часто говорит с незнакомцами первым. В начале исландской сцены они находятся далеко от селения. Письмо идёт с конкретным гонцом, занимает время и может опаздывать. Рагнар знает, кто имел доступ к принцу у него на глазах; о приказе Торсу ему могут рассказать лишь люди, видевшие нужную запись. На стороне Кнуда возможна отдельная сцена, где Рагнар согласится не отвечать за него.',
      ['письмо Кнуда', 'доступ к принцу', 'воспитатель Кнуда', 'letter from Canute', 'access to the prince', 'Danish court'],
      'Ragnar, Canute, and a letter from across the sea',
      'Ragnar protects Canute and often speaks first with strangers. Both are away from the Icelandic village at the opening. A message travels with an identifiable messenger and can arrive late. Ragnar knows who reached the prince in his presence. He needs an actual source to learn about the order given to Thors. A parallel scene may show Ragnar agreeing to let Canute answer for himself.'),
    entry('companies-and-crossing',['bjorn','thorkell'],'Бьёрн, Торкель и чужие отряды',
      'Бьёрн действует с людьми Аскеладда; его доверие к капитану и цель отряда имеют значение. Торкель ведёт собственных людей и не подчиняется Бьёрну. В начале ни один из них не обязан находиться на исландском причале. Связать их с походом можно через другой маршрут, приказ, встречу или очевидца. Одна и та же отметка на карте не делает приказ общим, а встреча не предрешает судьбу Торса.',
      ['отряд Бьёрна', 'люди Торкеля', 'наёмники у пролива', 'Bjorn’s crew', 'Thorkell’s men', 'mercenary landing'],
      'Bjorn, Thorkell, and separate companies',
      'Bjorn serves with Askeladd’s company; his loyalty and that company’s task matter. Thorkell leads his own men and is outside Bjorn’s command. Neither needs to be at the Icelandic jetty. A different route, order, meeting, or witness can bring them into the voyage. A shared map mark does not make their orders the same, and a meeting does not settle Thors’s fate.')
  ],
  aincrad: [
    entry('raid-gathering',['diavel','klein'],'Диавель, Клайн и собрание первого рейда',
      'Диавель может распределить позиции и объяснить общий сигнал отхода. Клайн ищет своих друзей и спрашивает, нужна ли помощь новичкам, которые не понимают карту. У них разные критерии успеха. Группа может начать с одного проверяемого прохода, назначить сопровождающего или отложить выступление. Кто вернулся после проверки и какие сведения услышал лично, важно для дальнейшего доверия.',
      ['первое собрание рейда', 'сигнал отхода', 'добровольцы первого этажа', 'first raid meeting', 'retreat signal', 'first-floor volunteers'],
      'Diavel, Klein, and the first raid gathering',
      'Diavel can assign positions and agree on a retreat signal. Klein is looking for his friends and asks what help beginners need with the map. They judge success differently. Start with one verified route, offer an escort, or delay. Who returned and who heard a report firsthand will matter for later trust.'),
    entry('gate-trade',['agil'],'Эгиль, снабжение и обмен на карте',
      'Группа может найти Эгиля рядом с торговцами или на сборе игроков. Он умеет оценить цену запаса и сказать, что реально вынести за ворота. Эгиль не знает путь, пока кто-то его не прошёл. Если ресурс дали в долг, сохрани условие возврата. Если предлагают обмен на тайну беты, Эгиль может проверить, нужна ли эта тайна людям сейчас.',
      ['запасы у ворот', 'торговец Айнкрада', 'снаряжение в долг', 'supplies at the gate', 'Aincrad merchant', 'equipment on credit'],
      'Agil, supplies, and trading for a map',
      'Agil can be found with traders or at a players’ gathering. He can judge the cost and weight of supplies. He needs a firsthand report before vouching for a route. Keep the terms when he extends credit. If someone wants to trade a beta secret, Agil can ask whether the people leaving today actually need it.')
  ],
  fairy: [
    entry('sylph-negotiators',['recon','sakuya'],'Рекон, Сакуя и условия для проводника',
      'Рекон может сообщить Лифе, за кем шёл и где потерял след. Сакуя может поручиться за проводника или маршрут в пределах договорённости сильфов. Предупреждение разведчика требует времени и подтверждения. Если проводник требует помощи соседям, оставь вопрос, кто может дать это обещание. Союз, пропуск от фракции и правила доступа к Мировому древу не взаимозаменяемы.',
      ['проводник сильфов', 'доклад Рекона', 'встреча фракций', 'Sylph guide', 'faction meeting', 'scout report from Recon'],
      'Recon, Sakuya, and terms for a guide',
      'Recon can tell Leafa whom he followed and where he lost the trail. Sakuya can vouch for a guide or route within the limits of a Sylph agreement. Check the scout’s warning and when he sent it. If the guide asks for help for another group, decide who has authority to commit. A faction agreement cannot replace the World Tree’s access rules.'),
    entry('sugou-access',['sugou'],'Суго и доступ за пределами поля зрения',
      'У Суго есть влияние на технологию и порядок доступа, но участник разговора видит только его действия и подтверждённые полномочия. Асуна может оставить след внутри системы, а Кирито — узнать о человеке снаружи. Связь между Суго, именем Оберон и конкретным ограничением требует нескольких шагов подтверждения. Не вкладывай внутреннюю информацию организации в уста Лифы без сцены передачи.',
      ['права Оберона', 'контроль доступа к пленнице', 'след из системы', 'Oberon permissions', 'captive access log', 'administrative trace'],
      'Sugou and access outside the viewpoint',
      'Sugou has influence over the technology and its access rules. A viewpoint character sees his actions and any permissions they can confirm. Asuna can leave evidence inside the system; Kirito can learn about a person outside it. Establish any link between Sugou, the name Oberon, and a particular restriction through evidence. Leafa does not acquire internal information without a source.')
  ],
  extra: [
    entry('dive-preparation',['silica','lisbeth'],'Силика, Лизбет и проверка перед погружением',
      'Силика может заметить, кто растерялся на тренировке или отстал. Лизбет проверяет снаряжение и узлы, предлагает ремонт либо ограниченный пробный спуск. Пина знакома Силике как спутник; её присутствие и возможности под водой определяют правила задания. Группа может перенести погружение и договориться о наблюдателе, когда участник ещё не готов.',
      ['тренировочный спуск', 'проверка ремней', 'кто страхует', 'practice dive', 'check the harness', 'dive buddy'],
      'Silica, Lisbeth, and checks before the dive',
      'Silica often notices who is uncomfortable or lagging behind. Lisbeth checks gear and fastenings and may suggest a repair or trial descent. Pina is familiar to Silica, while the quest determines whether her companion appears and what it can do underwater. The group can postpone the dive and assign someone to watch if a member is not ready.'),
    entry('different-witnesses',['klein'],'Клайн и раздельная память об Айнкраде',
      'Клайн может вспомнить собственную группу, место сбора или обещание, которое кому-то дал. Он не видел весь путь Кирито. Когда рассказ влияет на нынешнее задание, покажи, что услышал каждый участник и как его опыт изменил решение на тренировке. Ошибочное воспоминание можно проверить разговором с другим выжившим, не разыгрывая всю прежнюю арку.',
      ['память Клайна', 'рассказ о рейде', 'сверить воспоминания', 'Klein’s memory', 'compare survivor accounts', 'remember the raid'],
      'Klein and separate memories of Aincrad',
      'Klein can recall his own friends, a rendezvous point, or a promise. He did not witness Kirito’s whole journey. If the memory matters during preparation, establish who heard the account and what choice it changed. Another survivor can correct a memory without requiring a retelling of the old arc.')
  ],
  phantom: [
    entry('shinkawa-contact',['shinkawa'],'Кёдзи и внешняя линия Сино',
      'Кёдзи знаком с Сино Асадой вне матча. Он может знать то, что видел при личной встрече или узнал с её слов. Доступ к турнирным записям и причастность к происшествию нужно отдельно установить. Сино вправе отказаться от встречи, выбрать другого собеседника или предложить разговор при свидетеле. Отношения не являются уликой автоматически.',
      ['внешняя линия Сино', 'знакомый Асады', 'проверить встречу вне игры', 'Shino’s acquaintance', 'meet outside the game', 'real-world witness'],
      'Kyouji and Shino’s life outside GGO',
      'Kyouji knows Shino Asada outside the match. His knowledge comes from personal encounters and what she told him. Establish any tournament access or involvement in an incident separately. Shino can refuse a meeting, speak with someone else, or ask for a witness. A relationship alone is not evidence.'),
    entry('dyne-evidence',['dyne'],'Дайн и сектор наблюдения отряда',
      'Дайн возглавлял отряд, в котором играла Синон. Он может назвать время контакта и видимую часть маршрута, но не то, что было за укрытием. Синон может подтвердить другую часть из своей позиции. Совпадение показаний по времени ещё не доказывает, кем был стрелок. В качестве развилки группа может сравнить две записи, попросить третий источник или не раскрывать свою догадку до проверки.',
      ['сектор Дайна', 'след отряда Синон', 'свести показания', 'squad sightline', 'Sinon’s squad', 'compare firing positions'],
      'Dyne and his squad’s view of the scene',
      'Dyne led a squad in which Sinon fought. He can state the contact time and what was visible from his position. Sinon can confirm a different section. Consistent times alone do not identify the shooter. Compare two records, seek a third source, or keep the hypothesis private until it is tested.')
  ],
  calibur: [
    entry('tonkii-crossing',['tonkii','klein'],'Тонки, Клайн и решение о переправе',
      'Лифа знает, как подать знакомый сигнал Тонки, а Клайн может держать позицию у входа или сопровождать отстающих. Существо может отказаться приблизиться к шумной группе, помочь только до определённой высоты или изменить путь после угрозы. Согласие показывается действием. Отдельно реши, кто остаётся с жителями и как отряд узнает, что переправа сорвалась.',
      ['сигнал Тонки', 'удерживать проход', 'переправа у Йотунхейма', 'Tonkii crossing', 'hold the passage', 'Jotunheim crossing'],
      'Tonkii, Klein, and the crossing',
      'Leafa knows a familiar signal for Tonkii. Klein can hold the entrance or escort people who fall behind. The creature may stay away from a noisy group, assist only for part of the route, or change course after danger appears. Show willingness through action. Decide who stays with the inhabitants and how the party hears that the crossing failed.'),
    entry('giant-court',['thrym'],'Трюм и варианты у ворот великанов',
      'Трюм может удерживать рубеж, требовать ухода или вести переговоры от лица собственных великанов. Вход в зал, судьба местных и получение Экскалибура — задачи с разными условиями. Отход ради спасения жителей можно признать осознанным решением даже без награды. Особые механики боя и сведения о скрытых предметах требуют наблюдения или рассказа источника на месте.',
      ['двор великанов', 'переговоры с Трюмом', 'замок Трима', 'frost giant court', 'negotiate with Thrym', 'giant keep'],
      'Thrym and choices at the frost giants’ gate',
      'Thrym can hold a position, demand withdrawal, or bargain for his own giants. Entry to the hall, the inhabitants’ fate, and claiming Excalibur have different conditions. Retreating to save locals can be a deliberate choice. Special mechanics and knowledge of hidden objects require observation or a source inside the scene.')
  ],
  rosario: [
    entry('members-and-roles',['siune','jun'],'Сиунэ, Дзюн и место для каждого в рейде',
      'Сиунэ предлагает очередность поддержки и следит, чтобы к решению подключили всю команду. Дзюн охотно первым проверяет рискованный подход. Он может уступить позицию, если понятно, чем помочь иначе. Шесть игроков гильдии и Асуна при её согласии обсуждают вклад каждого. Одно свободное место, срок попытки и право на запись имён требуют разных договорённостей. Личные обстоятельства участников открывают они сами.',
      ['распределение ролей рейда', 'кто лечит в рейде', 'целительница гильдии', 'assign raid roles', 'guild healer', 'frontline volunteer'],
      'Siune, Jun, and a role for each raider',
      'Siune proposes the order of support and brings quieter guild members into the decision. Jun is eager to test a risky approach and can give up a position if he understands how else to help. The six guild members and Asuna, if she agrees, discuss everyone’s contribution. The final slot, attempt timing, and recording names require separate agreements. Each member chooses what to disclose about their life.'),
    entry('outside-help',['lisbeth'],'Лизбет и помощь вне состава Sleeping Knights',
      'Лизбет может обсудить с Асуной оружие и собственные сомнения перед рейдом. Её помощь не добавляет места в группу и не даёт ей права рассказывать за Юки. Если героини узнают, что другая группа уже готовится к боссу, они могут заранее договориться о последовательности, запросить подтверждение или отложить первый заход. Цель гильдии и право каждого участника выбирать важнее автоматической победы.',
      ['оружие Асуны перед рейдом', 'совет Лизбет', 'спор о первой попытке', 'Asuna’s raid gear', 'help outside the guild', 'dispute over the first attempt'],
      'Lisbeth and support outside the Sleeping Knights',
      'Lisbeth can talk through equipment and reservations with Asuna. Her help does not add a raid slot or give her the right to speak for Yuuki. If another group is already preparing for the boss, agree on order, request proof, or postpone. The guild’s goal and each member’s freedom to choose matter.')
  ],
  ordinal: [
    entry('augma-developer',['shigemura'],'Профессор Сигэмура и журнал Augma',
      'Сигэмура разработал Augma и умеет судить о свойствах устройства. Это не означает, что любая запись пришла лично от него. Разделяй разработчика, оператора мероприятия, источник журнала и участника с пробелом в памяти. Герои могут обратиться к Сигэмуре с двумя разными показаниями либо потребовать независимую проверку. Связь с Эйдзи и Юной раскрывается только когда её подтверждает эта версия истории.',
      ['разработчик Augma', 'журнал Augma', 'источник расписания', 'Augma developer', 'Augma event log', 'schedule discrepancy'],
      'Professor Shigemura and the Augma log',
      'Shigemura developed Augma and understands what the device can do. That does not mean each record originated with him. Keep the developer, event operator, log source, and person with a memory gap distinct. The characters can bring contrasting accounts to the professor or ask for an independent check. Links to Eiji and Yuna emerge only through evidence this story establishes.'),
    entry('ar-witness-team',['silica','lisbeth','klein'],'Силика, Лизбет и Клайн как свидетели AR',
      'Силика может первой сказать, где находилась и что показал её Augma. Лизбет сравнивает последовательность, а Клайн может назвать людей, которых видел без устройства. У свидетелей разные маршруты и право отказаться от участия в проверке памяти. Сравни время, источник приглашения и установленные изменения в памяти; одно расхождение не доказывает умышленной подмены.',
      ['показания участников AR', 'сравнить два Augma', 'физический очевидец', 'AR witness', 'compare Augma displays', 'different start time'],
      'Silica, Lisbeth, and Klein as AR witnesses',
      'Silica can say where she stood and what her Augma displayed. Lisbeth can compare sequences, while Klein can name people he saw without the device. Witnesses traveled different routes and may decline any memory check. Compare timing, sources of invitations, and established memory changes. A discrepancy alone does not establish tampering.')
  ],
  alicization: [
    entry('church-and-selka',['selka'],'Селька, церковь и расходящиеся записи Рулида',
      'Селька учится при церкви и знает распорядок детей и местных обязанностей. Она может показать, где лежит копия или кто её передал. Один почерк не объясняет, почему изменилась запись. Она способна спорить с Юджио о том, как поступить, и говорить за собственные решения. Селька не обладает памятью Алисы или сведениями об операторах.',
      ['церковь Рулида', 'запись из церкви', 'сестра Алисы', 'Rulid church', 'church records', 'Alice’s sister', "Alice's sister"],
      'Selka, the church, and Rulid’s conflicting records',
      'Selka studies at the church and knows the children’s schedule and local duties. She can point to a copy of a record or say who delivered it. Handwriting alone does not explain a change. She can challenge Eugeo and speaks for her own choices. She does not share Alice’s memories or know the outside operators.'),
    entry('rinco-link',['rinko'],'Ринко, Асуна и границы внешней связи',
      'Ринко может объяснить Асуне назначение технологии и какое сообщение наблюдал оператор. Различай записи установки, предположение исследователя и опыт жителя Рулида. Пока подходящий канал не установлен, открытие снаружи ничего не сообщает Юджио или Сельке. Это даёт две самостоятельные линии: найти человека с доступом и проверить след внутри мира.',
      ['внешняя линия Ринко', 'данные оператора', 'доступ к Soul Translator', 'operator records', 'outside contact', 'Soul Translator access'],
      'Rinko, Asuna, and the limits of outside contact',
      'Rinko can explain the technology and what an operator actually saw. Distinguish device records, a researcher’s theory, and the experience of a Rulid resident. Until a channel is established, an outside discovery does not inform Eugeo or Selka. The two lines can proceed independently: find someone with access and investigate a trace inside.')
  ],
  war: [
    entry('fanatio-reserves',['fanatio'],'Фанатио, Беркули и проверка резервов',
      'Фанатио может объяснить, какие силы реально доступны и что сообщил её участок. Распоряжение Беркули ограничено тем, что доставлено до командиров. Если приказывают открыть коридор, определи его границы, кто охраняет и кто подтвердил прибытие первой группы. Противник может предложить иные условия. Согласие одного отряда не делает весь фронт безопасным.',
      ['приказ Фанатио', 'резервы рыцарей', 'сверить донесение', 'knight reserves', 'Fanatio’s orders', 'check the dispatch'],
      'Fanatio, Bercouli, and checking the reserves',
      'Fanatio can say which forces are available and what her sector reported. Bercouli’s orders reach only commanders who received them. When opening a corridor, establish its boundaries, who guards it, and who confirmed that the first group arrived. An opposing force can make a different offer. One unit’s consent does not make the front safe.'),
    entry('meeting-across-front',['sheyta','iskahn'],'Шейта, Искан и договор двух отрядов',
      'Шейта и Искан могут встретиться, когда их позиции и способ связи установлены. Шейта не говорит за весь Орден, Искан отвечает за своих бойцов, а не за все силы Тёмной территории. У обеих сторон основания защищать раненых. Возможны короткая пауза, обмен проводниками или отказ со своими последствиями. Личное уважение может вырасти из выбора в сцене; соглашение и будущие отношения не предрешены.',
      ['пауза у передовой', 'эвакуация обеих сторон', 'договор бойцов', 'local battlefield truce', 'both sides’ wounded', 'negotiate safe passage'],
      'Sheyta, Iskahn, and an agreement between units',
      'Sheyta and Iskahn can meet once their positions and means of contact are established. Sheyta does not speak for her whole Order, and Iskahn is accountable for his own fighters. Both can choose to protect casualties. A brief pause, an exchange of guides, or a refusal has consequences. Respect and future relationships can grow out of choices made here.')
  ],
  aria: [
    entry('first-floor-terms',['diavel'],'Диавель и порядок первого боя в Progressive',
      'Диавель может собрать передовые группы, проверить полученные сведения о первом этаже и назначить сигнал сбора. Это сведения версии Progressive, которую герои ещё проверяют. Асуна и Мито вправе возразить, если для новичков нет понятного пути назад. Диавель может уточнить свою карту и разделить разведку и основную попытку. Успех и судьба организатора остаются открытыми.',
      ['совещание Диавеля', 'рейд Progressive', 'порядок первого боя', 'Diavel’s raid meeting', 'Progressive first raid', 'first attempt procedure'],
      'Diavel and the first Progressive raid',
      'Diavel can bring the front-line parties together, inspect the first-floor report, and set a rally signal. This branch uses Progressive conditions that the group must verify. Asuna and Mito can challenge the plan if beginners have no clear way back. Diavel can check his map and separate scouting from the real attempt. His fate and the result remain open.'),
    entry('inexperienced-team',['agil'],'Эгиль и безопасность новичков в Progressive',
      'Эгиль умеет заметить, кому не хватит припасов и кто ещё не умеет держать дистанцию. Он может предложить подготовку вне рейда, сопровождение или собственный способ проверить расстановку. Его свидетельство о первом этаже не раскрывает прошлое Асуны и Мито. Если игроки не доверяют старшим, покажи, как конкретное обязательство поддаётся проверке.',
      ['новички Progressive', 'припасы для первого рейда', 'учебный отход', 'Progressive beginners', 'first-raid supplies', 'practice retreat'],
      'Agil and beginner safety in Progressive',
      'Agil can notice who lacks supplies or does not know how to maintain range. He may suggest practice, an escort, or an independent check of positions. His first-floor evidence does not disclose Asuna and Mito’s history. If new players distrust veterans, give them a concrete commitment they can verify.')
  ],
  scherzo: [
    entry('cross-guild-witnesses',['liten','shivata'],'Литэн и Сивата между двумя гильдиями',
      'Литэн умеет держать узкий проход, Сивата может принести независимое свидетельство от другой стороны. Они могут сверить карту лично, договориться о месте встречи или выступить за ограниченное соглашение. Их доверие помогает разговору, но не означает, что лидеры уже согласны. Не превращай подозрение к соперникам в знание о намерениях конкретного человека.',
      ['переговоры двух гильдий', 'свидетель из другой группы', 'личное обещание у развилки', 'cross-guild witnesses', 'interguild agreement', 'private meeting at the fork'],
      'Liten and Shivata between the two guilds',
      'Liten can hold a narrow passage, and Shivata can bring an independent observation from the other side. They can compare the map together, agree on a meeting point, or negotiate a narrow arrangement. Trust starts a conversation without binding guild leaders. Suspicion of a guild does not establish an individual’s intentions.'),
    entry('guarded-find',['liten','shivata'],'Хранение спорной добычи и право решения',
      'Если у развилки находят спорную награду, Литэн может остаться на охране, а Сивата подтвердить, кто видел находку. Сначала реши, физически ли предмет здесь, кто его видел и кто может обещать условия от лица гильдии. Отдать предмет на временное хранение, выяснить источник или закрыть доступ — отдельные действия. Подтверждение со стороны меняет доверие, не превращаясь в победу над боссом.',
      ['хранение добычи', 'свидетель выпадения', 'спорный предмет под охраной', 'loot custody', 'verified item drop', 'guard the disputed loot'],
      'Disputed loot, custody, and authority',
      'If the group finds disputed loot at the fork, Liten can guard it while Shivata confirms who witnessed the discovery. First establish whether the item is present, who saw it, and who can speak for a guild. Temporary custody, tracing the source, and closing access are different choices. A second witness can change trust without deciding the boss battle.')
  ],
  ggo: [
    entry('shinc-scouts',['boss','tanya'],'Эва, Таня и разведка SHINC',
      'Командир SHINC Эва задаёт общий маршрут. Таня может докладывать со своего сектора, передавая направление движения отдельно от вывода о числе противников. Если связь пропала, командир решает, ждать ли подтверждения. Контакт с LLENN может начаться с наблюдения или переговоров. Личные сведения об участниках не открываются по игровой экипировке.',
      ['доклад SHINC', 'командир SHINC', 'разведчица на карте', 'SHINC report', 'SHINC captain', 'scout’s sector'],
      'Eva, Tanya, and SHINC reconnaissance',
      'Eva sets SHINC’s route. Tanya reports what she can see, separating the direction of movement from an estimate of numbers. If communications fail, Eva chooses whether to wait for confirmation. Contact with LLENN can begin through observation or negotiation. An avatar’s appearance does not reveal an opponent’s real identity.'),
    entry('shinc-terms',['boss','tanya'],'Граница договорённости с SHINC',
      'При неполной карте Эва может предложить обмен одним ориентиром, а Таня — проверить, был ли проход открыт сейчас. Это не обещание союза на весь матч. Герои вправе затребовать подтверждение, отказаться от рискованного обмена или изменить путь после неверного доклада. Договорённость требует понятного срока и метода связи.',
      ['обмен ориентирами', 'временный договор с SHINC', 'проверка маршрута бойцами', 'temporary pact with SHINC', 'trade landmark information', 'verify a passage'],
      'Limits of a deal with SHINC',
      'With an incomplete map, Eva can trade one landmark while Tanya verifies whether the passage is still open. A narrow agreement does not guarantee an alliance for the rest of the match. Characters can ask for confirmation, decline the risk, or change routes after a bad report. Set an end time and a way to make contact.')
  ],
  'ggo-2': [
    entry('third-jam-rivals',['clarence','shirley'],'Кларенс, Ширли и меняющаяся линия воды',
      'Кларенс может рискнуть временной договорённостью, Ширли изучает сектор перед сближением. Их планы могут совпасть по маршруту и расходиться по выбору момента. Оба маршрута зависят от текущей линии воды и правил, которые уже объявили. Можно запросить один ориентир, проверить условие вместе или разойтись. Прежняя враждебность и будущие повороты не решают результат этой ветки.',
      ['затопление и сделка', 'снайпер у линии воды', 'изменить маршрут с соперником', 'temporary deal during flooding', 'sniper at the waterline', 'pair of rival scouts'],
      'Clarence, Shirley, and the changing waterline',
      'Clarence may risk a temporary deal while Shirley studies the area before approaching. Their routes can coincide even when they disagree about timing. Both depend on the observed waterline and the rules already announced. Ask for one landmark, verify a term together, or split up. Past hostility and later twists leave this branch open.'),
    entry('third-jam-shinc',['boss'],'Эва и отдельная задача SHINC в Squad Jam 3',
      'У SHINC есть собственные цели и время достижения безопасной позиции. Эва может согласиться разойтись с LPFM до определённой отметки или обменять короткий доклад. Она не знает закрытых условий турнира, показаний интерфейса LPFM и будущих ходов соперника. Проверяй, кто принял сообщение и чем команда рискует, если вторая сторона передумает.',
      ['SHINC и LPFM', 'договор двух команд', 'объявленные правила третьего турнира', 'SHINC and LPFM', 'Squad Jam 3 agreement', 'third match conditions'],
      'Eva and SHINC’s separate goal in Squad Jam 3',
      'SHINC has its own objective and deadline for reaching safety. Eva can agree to separate from LPFM at a landmark or exchange a brief report. She does not know unrevealed conditions, LPFM’s interface, or future decisions. Confirm who heard the message and what each team risks if the other changes course.')
  ]
};
