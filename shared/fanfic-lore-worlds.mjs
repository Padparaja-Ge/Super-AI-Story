function reference(name,content,keys,englishName,englishContent) {
  return {name,content,keys,priority:18,reference:{name:englishName,content:englishContent}};
}

export const fanficWorldLore={
  jujutsu:[
    reference('Вечерний Сэндай и границы доступа',
      'В обычном Сэндае действуют расписание транспорта, школьные ключи, кабинеты охраны и привычные объяснения для мирных жителей. Взрослый сотрудник может подтвердить обход или открыть дверь, но не знает технику магов. Внутри школы полезно различать людный вход, служебный путь и помещение, которое можно изолировать. Вызов помощи, эвакуация и передача реликвии — разные задачи, и у каждой свой след.',
      ['вечерний обход','служебный выход','школьные ключи','school keys','service exit','school security desk'],
      'Sendai after hours and the limits of access',
      'Ordinary Sendai runs on transit schedules, school keys, security offices, and explanations civilians would accept. A staff member can confirm a patrol or unlock a door without understanding sorcerers’ techniques. Distinguish the crowded entrance, a service route, and a room that can be isolated. Calling help, evacuating students, and transferring the relic are separate tasks with separate evidence.'),
    reference('Маги и цена публичной тайны',
      'Сотрудники школы магов принимают решения по отчётам о том, что произошло и кто отвечает за предмет. Мирный очевидец может заслуживать доверия, даже если объясняет события иначе. Помощь не обязывает школьника стать магом. Разговор после опасности решает, кому раскрыть часть сведений, а записи и свидетели делают ложное прикрытие уязвимым.',
      ['отчёт Мэгуми','свидетель из школы','официальная версия','сорвать прикрытие','sorcerer report','civilian witness','cover story'],
      'Sorcerers and the cost of secrecy',
      'Jujutsu High acts on reports about what happened and who has custody. A civilian witness can be credible while interpreting events differently. Giving aid does not oblige a student to become a sorcerer. A conversation after the danger decides who learns which details. Witnesses and written records make a false cover story vulnerable.')
  ],
  edgerunners:[
    reference('Найт-Сити: район, деньги и доступ',
      'Маршрут, который доступен корпоративному гостю по пропуску, уличной команде может стоить времени, платы посреднику или опасного крюка. Санто-Доминго даёт работу и дешёвые пути через промзону, но не обещает быстрый доступ в центр. Отдельно отмечай, кто платит за лечение, ремонт или сорванную смену. Невидимая цена сделки проявляется при следующем контакте.',
      ['пропуск корпорации','платный проход','пересадка ночью','долг за ремонт','corporate pass','night commute','repair debt','restricted checkpoint'],
      'Night City: district, money, and access',
      'A guest with a corporate pass crosses places that cost a street crew time, an intermediary’s fee, or a dangerous detour. Santo Domingo provides industrial work and cheap local routes without quick access to downtown. Keep track of who pays for treatment, equipment repair, or a lost shift. A hidden cost of a deal becomes visible at the next contact.'),
    reference('Фиксер, клиент и репутация команды',
      'Клиент нанимает исполнителей через фиксеров, а доверие идёт от выполненных условий и людей, готовых подтвердить их. Проверка клиента, след посылки и назначенный получатель — три источника, которые можно сопоставлять. Лишний вопрос может раскрыть интерес команды. Отказ от работы допустим, но клиент тогда может уйти к соперникам, изменить условия или потребовать возврат аванса.',
      ['аванс за заказ','проверить клиента','выход из сделки','назначенный получатель','client verification','return the advance','cancel the job','crew reputation'],
      'Fixers, clients, and crew reputation',
      'A client hires through a fixer. Trust comes from completed terms and people willing to vouch for them. Checking the client, tracing a package, and identifying its recipient give different evidence. An extra question can reveal the crew’s interest. Declining a job remains possible and may send the client to a rival, change the terms, or put the advance in dispute.')
  ],
  vinland:[
    reference('Исландское селение: работа, запасы и зима',
      'У дороги, причала и общего склада в деревне разные свидетели. Дерево, железо, канаты, сухая одежда и еда требуют труда и времени. Отсутствие кормильца после отплытия меняет, кто возит груз и что семья может обещать соседям. В холодную погоду даже простой план стоит перепроверить по запасам, сменам работы и состоянию лодки.',
      ['семейное хозяйство','припасы на зиму','общий склад','лодка у причала','winter provisions','village stores','household work','village jetty'],
      'An Icelandic settlement: work, stores, and winter',
      'Different people witness events on the road, at the jetty, and by the common storehouse. Timber, iron, rope, dry clothes, and food cost time and work. A worker’s departure changes who can carry goods and what the household can promise its neighbors. In cold weather, check even a simple plan against supplies, duties, and the boat’s condition.'),
    reference('Власть, устное обещание и дорога по морю',
      'Весть с дальнего берега приходит через конкретное судно и человека, умеющего рассказать, что видел. Военная обязанность, гостеприимство и обещание перед семьёй могут конфликтовать. Удерживай, кто дал слово, кто его слышал и кто отвечает за последствия. При изменении маршрута учти ветер, возможность укрыться у берега и число людей, которые могут вести судно.',
      ['устное обещание','свидетель клятвы','весть с моря','изменить курс','oath witness','news from overseas','change course','sail under oath'],
      'Authority, spoken promises, and travel by sea',
      'News from a distant coast arrives on a particular ship with a person who can say what they saw. Military duty, hospitality, and an obligation to family can conflict. Track the speaker, witnesses, and who bears the consequences. A route change depends on wind, possible shelter, and the number of people able to handle the ship.')
  ],
  sao:[
    reference('Аватар, устройство и доступ к миру',
      'Уточни текущую ветку и устройство, через которое персонаж действует. Сведения на интерфейсе одного участника не обязаны быть доступны другому. Путь входа, побеждённый аватар, сведения о настоящем игроке и права администрирования — отдельные факты. Новая возможность появляется через установленное правило ветки или событие на странице.',
      ['права аватара','интерфейс игрока','сменить аватар','доступ к серверу','avatar permissions','player interface','change avatar','access rights'],
      'Avatars, devices, and access to a world',
      'Confirm the active branch and the device a character uses. Information shown to one participant may be unavailable to another. The means of entry, a defeated avatar, real-world identity, and administrative permissions are separate facts. A new ability comes from an established branch rule or an event the story shows.'),
    reference('Группа, разведка и подтверждение маршрута',
      'Карты, сообщения группы и наблюдения свидетеля могут расходиться. Для опасного прохода отделяй последний подтверждённый ориентир, время сбора и доступный путь отхода. Социальная репутация открывает переговоры, но не подтверждает чужой рассказ о выходе или награде. Правила разведки остаются внутри выбранной игры, сезона или фильма.',
      ['договориться о встрече','путь отхода','проверить маршрут','отметка на карте','rally point','retreat route','confirm the route','map marker'],
      'Parties, scouting, and route confirmation',
      'A map, a party message, and an eyewitness account can disagree. For a dangerous route, keep the last confirmed landmark, meeting time, and viable retreat distinct. Reputation can open negotiations without proving a story about an exit or reward. The available scouting rules come from the chosen game, season, or film.')
  ]
};
