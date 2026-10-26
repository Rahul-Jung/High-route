'use strict';
/* ===========================================================================
   REFERENCE DATA — activity types, destination page content, FAQs, and the
   skeleton of the annual impact report.

   Three rules this file follows, because the brief is emphatic about them:

   1. Nothing here is fabricated business data. The destination copy is
      geography, permits and seasons — facts about Nepal that hold whoever is
      selling the trip. There are no invented partner names, no invented
      accommodation, no invented contributions.

   2. The impact metrics are seeded as LABELLED ROWS WITH NO VALUES. The Our
      Impact page is required to show annual progress; publishing a number
      nobody measured would be the one thing the brief rules out hardest. So
      the structure ships, each metric reads "not yet published", and the
      page says who has to supply it. `evidenced` stays 0 until an admin
      ticks it.

   3. Every insert is INSERT OR IGNORE against a natural key, or guarded by
      an existence check, so this is safe on every boot and never overwrites
      something an admin has since edited.
   =========================================================================== */

module.exports = function seedReferenceData(db) {
  const get = (sql, p = []) => db.prepare(sql).get(...p);
  const run = (sql, p = []) => db.prepare(sql).run(...p);

  /* =======================================================================
     ACTIVITY TYPES

     `enabled` is what the public site reads. Mountain biking is the launch
     category and has real trips. Trekking and multi-activity are enabled
     because the brief puts them in the main navigation — their category
     pages render an honest "no trips published yet, here is how to ask for
     one" state rather than invented itineraries. Rafting and trail running
     stay disabled: the data model and admin panel support them in full, but
     an adventure category with nothing in it and no plan to launch does not
     belong in a visitor's navigation.
     ======================================================================= */
  const ACTIVITIES = [
    ['mountain-biking', 'Mountain Biking', 'Mountain Bike Adventures',
      'Himalayan singletrack, jeep-road descents and high passes, ridden with local guides.', 'bike', 1, 1],
    ['trekking', 'Trekking', 'Trekking Adventures',
      'Walking the same valleys and passes, at walking pace, sleeping in teahouses and lodges.', 'boot', 1, 2],
    ['multi-activity', 'Multi-Activity', 'Multi-Activity Adventures',
      'More than one way to move through a region — ride, walk and paddle on the same trip.', 'compass', 1, 3],
    ['rafting', 'Rafting', 'Rafting Adventures',
      "Nepal's snow-fed rivers, from half-day warm-ups to multi-day wilderness descents.", 'wave', 0, 4],
    ['trail-running', 'Trail Running', 'Trail Running Adventures',
      'Fast, light days on the same trails, with support and acclimatisation built in.', 'run', 0, 5],
  ];
  for (const [slug, name, plural, summary, icon, enabled, sort] of ACTIVITIES) {
    run(
      `INSERT INTO activity_types (slug, name, plural_label, summary, icon, enabled, sort_order)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(slug) DO NOTHING`,
      [slug, name, plural, summary, icon, enabled, sort]
    );
  }

  /* =======================================================================
     DESTINATIONS

     Everest is added because the brief lists it as a launch destination.
     It carries no mountain-bike adventures and the page says why in plain
     terms — the main Khumbu trails are stone staircases shared with a great
     many walkers and porters, which is a trekking destination, not a riding
     one. Saying that is more useful than quietly listing nothing, and it is
     the honest reason the category is empty.

     Everything below is geography, permit structure and season. Permit FEES
     are deliberately not quoted anywhere: they are set by Nepal's Department
     of Immigration and the conservation-area authorities and they change.
     The pages say which permit is required and that the current fee must be
     confirmed at booking.
     ======================================================================= */
  const DESTINATIONS = [
    {
      slug: 'everest', name: 'Everest', region: 'Khumbu', lat: 27.9881, lng: 86.925, sort_order: 7,
      hero_image_url: 'https://images.unsplash.com/photo-1544735716-392fe2489ffa?auto=format&fit=crop&w=1600&q=80',
      description: 'The Khumbu — Sagarmatha National Park, Sherpa valleys and the highest mountain on earth.',
    },
  ];
  for (const d of DESTINATIONS) {
    if (!get('SELECT id FROM destinations WHERE slug = ?', [d.slug])) {
      run(
        `INSERT INTO destinations (slug, name, region, description, hero_image_url, lat, lng, sort_order, auto_created)
         VALUES (?,?,?,?,?,?,?,?,0)`,
        [d.slug, d.name, d.region, d.description, d.hero_image_url, d.lat, d.lng, d.sort_order]
      );
    }
  }

  // Page content for the destinations, applied only where the field is still
  // empty — an admin's own copy is never overwritten.
  const DEST_CONTENT = {
    mustang: {
      name: 'Mustang',
      intro:
        'Upper Mustang is the old Kingdom of Lo, a high desert valley north of the Annapurna and Dhaulagiri massifs. '
        + 'Because both ranges stand between it and the monsoon, it sits in their rain shadow and stays dry and rideable '
        + 'through a summer that shuts most of Nepal down. The landscape is eroded red and ochre cliffs, walled villages '
        + 'and Tibetan-Buddhist gompas; the culture is closer to the Tibetan plateau than to Kathmandu. Lo Manthang, the '
        + 'walled capital, sits at about 3,840 m.',
      best_time:
        'Rideable far longer than the rest of Nepal. March to early November is the broad window, and Upper Mustang is one '
        + 'of the few Nepali regions that works through the June–September monsoon precisely because it is in the rain '
        + 'shadow. Expect a strong, reliable up-valley wind from late morning — most days are planned around riding the '
        + 'exposed sections early. Winter is clear but very cold, and many villages empty out as families move south.',
      elevation_range: '2,700 m (Jomsom) to roughly 4,200 m on the highest passes',
      getting_there:
        'Most trips start with a flight or drive to Pokhara, then either a short flight to Jomsom or the road up the Kali '
        + 'Gandaki gorge. The Jomsom airstrip is weather-dependent and morning-only; itineraries allow for that.',
      practical: [
        'Upper Mustang is a restricted area. A restricted-area permit and a registered guide are required, and the permit is issued per person for a fixed number of days. Fees are set by Nepal’s Department of Immigration and change — the current rate is confirmed at booking.',
        'An Annapurna Conservation Area (ACAP) permit is also required for the approach through the Kali Gandaki.',
        'Altitude is the main physical constraint, not gradient. Itineraries are built to gain height gradually.',
        'Accommodation is village lodges and guesthouses. Rooms are simple, hot water is not guaranteed, and charging is often paid for by the device.',
      ],
      activities: ['mountain-biking', 'trekking'],
      related: ['annapurna', 'pokhara'],
    },
    annapurna: {
      name: 'Annapurna',
      intro:
        'The Annapurna Conservation Area is Nepal’s largest protected area and the most varied riding and walking in the '
        + 'country. The classic circuit climbs the Marsyangdi valley on the east side, crosses Thorong La at 5,416 m, and '
        + 'drops into the Kali Gandaki on the west. Over the last two decades road building has reached much of the old '
        + 'trekking route, which is the honest reason mountain biking works here: there is now a continuous rideable line '
        + 'through the circuit, with singletrack alternatives still intact alongside it.',
      best_time:
        'October and November are the clearest and most settled months. March to May is warmer, hazier, and brings the '
        + 'rhododendron forests out below 3,500 m. The June–September monsoon makes the lower valleys wet and leech-prone '
        + 'and brings a real landslide risk on the road sections. December to February is clear and cold, and Thorong La '
        + 'is frequently closed by snow.',
      elevation_range: '800 m (Besisahar) to 5,416 m (Thorong La)',
      getting_there:
        'Drive from Kathmandu or Pokhara to Besisahar for the eastern approach, or to Beni and the Kali Gandaki for the west. '
        + 'Pokhara is the usual staging point.',
      practical: [
        'An ACAP permit and a TIMS card are required. Both are arranged as part of the trip.',
        'Thorong La is a genuine high pass. Any itinerary crossing it needs acclimatisation days built in, and they are not optional.',
        'Teahouses and lodges the whole way. Private rooms are usual at lower altitude, shared dormitories are common high up.',
        'Road and trail conditions change year to year as construction continues. Routes are confirmed close to departure.',
      ],
      activities: ['mountain-biking', 'trekking'],
      related: ['mustang', 'pokhara'],
    },
    everest: {
      name: 'Everest',
      intro:
        'The Khumbu is Sherpa country: Sagarmatha National Park, a UNESCO World Heritage site, running from the airstrip at '
        + 'Lukla up to Everest Base Camp at about 5,364 m. Namche Bazaar at 3,440 m is the hub, Tengboche monastery sits '
        + 'above the Imja valley, and the viewpoints at Kala Patthar (5,545 m) and Gokyo Ri look straight into the Everest '
        + 'massif.',
      best_time:
        'October–November and March–May. The Khumbu is busy in both windows; October is the busiest month on the trail. '
        + 'Monsoon brings cloud that hides the mountains and makes the Lukla flight unreliable. Winter is clear, very cold, '
        + 'and many high lodges close.',
      elevation_range: '2,845 m (Lukla) to 5,545 m (Kala Patthar)',
      getting_there:
        'A mountain flight from Kathmandu or Ramechhap to Lukla, which is weather-dependent and cancels regularly — any '
        + 'itinerary here needs spare days at both ends. The overland alternative via Jiri or Salleri adds several days of walking.',
      practical: [
        'A Sagarmatha National Park entry permit and the Khumbu Pasang Lhamu rural municipality fee are both required.',
        'We publish no mountain-bike trips in the Khumbu, and that is deliberate. The main trails are stone staircases on steep ground, shared with a very large number of walkers, porters and pack animals. Riding them is unpleasant for everyone involved and in places simply not possible. The Khumbu is a walking destination.',
        'Altitude is the defining risk. Base-camp itineraries that skip acclimatisation days are the single most common cause of people turning back.',
        'Teahouse lodges throughout, busy in season. Rooms above Dingboche are basic and cold.',
      ],
      activities: ['trekking'],
      related: ['kathmandu', 'langtang'],
    },
    pokhara: {
      name: 'Pokhara',
      intro:
        'Pokhara sits at about 800 m beside Phewa Lake, with the Annapurna massif rising straight out of the valley behind '
        + 'it — the shortest distance from a warm lakeside town to 8,000 m anywhere in the world. It is the staging point '
        + 'for most of central Nepal, and it has enough on its doorstep to be a destination in its own right: the ridge at '
        + 'Sarangkot, the forest trails toward Australian Camp, and the World Peace Pagoda above the south shore.',
      best_time:
        'Year-round. Pokhara is low and subtropical, so winter is mild and pleasant for riding while the high country is '
        + 'shut. October to April is the reliable window. Monsoon is genuinely wet and the trails turn greasy, but mornings '
        + 'often stay clear.',
      elevation_range: '800 m (Phewa Lake) to about 1,600 m (Sarangkot ridge)',
      getting_there:
        'A 25-minute flight or a six-to-eight hour drive from Kathmandu. There is also a direct road from the Indian border '
        + 'at Sunauli.',
      practical: [
        'No permit is needed for the day trails around the valley. Anything heading north into the Annapurna Conservation Area does need an ACAP permit.',
        'The best base for a short trip, a warm-up before altitude, or a family-friendly couple of days.',
        'Hotels and guesthouses across the full price range, concentrated along the lakeside.',
        'Heat and humidity are the limiting factor in spring and early summer, not altitude. Early starts matter.',
      ],
      activities: ['mountain-biking', 'multi-activity'],
      related: ['annapurna', 'kathmandu'],
    },
    kathmandu: {
      name: 'Kathmandu Valley',
      intro:
        'The valley floor sits at about 1,400 m, ringed by hills that climb to nearly 2,800 m at Phulchowki and Shivapuri. '
        + 'Inside that ring are seven UNESCO monument zones — the Durbar Squares of Kathmandu, Patan and Bhaktapur, '
        + 'Swayambhunath, Boudhanath, Pashupatinath and Changu Narayan. Outside it, the rim is a network of forest trails, '
        + 'terraced farmland and ridge roads that can be ridden all year.',
      best_time:
        'Year-round. October to April is clearest and coolest. The valley holds haze and dust in late winter and spring, '
        + 'and the monsoon makes the clay trails slick, but the rim rides in almost any conditions.',
      elevation_range: '1,300 m (valley floor) to 2,782 m (Phulchowki)',
      getting_there:
        'Tribhuvan International Airport is the country’s main entry point, so for most visitors the valley is the start '
        + 'and end of the trip whatever they came for.',
      practical: [
        'A Shivapuri Nagarjun National Park entry fee applies on the northern rim trails.',
        'The best place to shake off a long flight, test a bike, and get used to altitude before heading higher.',
        'Traffic and air quality on the valley roads are poor. Routes are planned to get out of the ring road quickly rather than ride through it.',
        'Hotels across every price range, and the only place in the country with reliable bike spares.',
      ],
      activities: ['mountain-biking', 'trekking', 'multi-activity'],
      related: ['langtang', 'pokhara'],
    },
    langtang: {
      name: 'Langtang',
      intro:
        'Langtang is the closest high valley to Kathmandu — a day’s drive north to the Tibetan border, inside Langtang '
        + 'National Park. The valley was hit extremely hard by the 2015 earthquake: Langtang village was destroyed by a '
        + 'landslide and much of what a visitor sees today has been rebuilt since. Kyanjin Gompa at about 3,870 m is the '
        + 'usual high point, under Langtang Lirung.',
      best_time:
        'October to April. Lower and more sheltered than the Annapurna or Manaslu circuits, so it holds up better in the '
        + 'shoulder months and makes a good early-season or late-season trip. The forest sections are wet and leechy in '
        + 'monsoon.',
      elevation_range: '1,500 m (Syabrubesi) to about 3,870 m (Kyanjin Gompa)',
      getting_there: 'Six to eight hours by road from Kathmandu to Syabrubesi. The road is rough and slides are common in and after monsoon.',
      practical: [
        'A Langtang National Park entry permit and a TIMS card are required.',
        'Tourism is a central part of the valley’s recovery from the 2015 earthquake, and visitor spending here is felt directly.',
        'Rebuilt teahouses and lodges, simpler than the Annapurna equivalents.',
        'Forest singletrack rather than high desert — the riding is technical and low-altitude by Nepali standards.',
      ],
      activities: ['mountain-biking', 'trekking'],
      related: ['kathmandu', 'manaslu'],
    },
    manaslu: {
      name: 'Manaslu',
      intro:
        'The Manaslu Circuit follows the Budhi Gandaki from subtropical farmland up to the Larkya La at 5,106 m, with the '
        + 'eighth-highest mountain in the world above it. It is a restricted area with far fewer visitors than Annapurna, '
        + 'and the upper valleys around Sama Gaun are culturally Tibetan. Remote, committing, and the hardest thing on '
        + 'this list.',
      best_time:
        'October–November, and a narrower March–May window. Larkya La holds snow late and closes early; outside the two '
        + 'windows a crossing cannot be relied on.',
      elevation_range: '700 m (Soti Khola) to 5,106 m (Larkya La)',
      getting_there: 'Road from Kathmandu to Soti Khola or Machha Khola, roughly eight to ten hours and rough at the far end.',
      practical: [
        'Manaslu is a restricted area. A restricted-area permit, a Manaslu Conservation Area permit and a licensed guide are all required, and permits are issued only to groups of two or more. Fees are set by the Department of Immigration and change — confirmed at booking.',
        'Larkya La at 5,106 m is the crux. It is a long day from a high camp, often on snow, and it is not a place to be carrying a bike unacclimatised.',
        'Lodges in the lower valley, basic teahouses high up, and a camp before the pass on most itineraries.',
        'There is no road access and no quick way out of the middle of this circuit. Evacuation means a helicopter and weather that allows one.',
      ],
      activities: ['mountain-biking', 'trekking'],
      related: ['annapurna', 'langtang'],
    },
  };

  for (const [slug, c] of Object.entries(DEST_CONTENT)) {
    const row = get('SELECT * FROM destinations WHERE slug = ?', [slug]);
    if (!row) continue;
    // COALESCE-style: only write a field that is still empty, so admin edits
    // survive every subsequent boot.
    const sets = [];
    const params = [];
    const maybe = (col, value) => {
      const current = row[col];
      if (current === null || current === undefined || current === '' || current === '[]') {
        sets.push(`${col} = ?`);
        params.push(value);
      }
    };
    maybe('intro', c.intro);
    maybe('best_time', c.best_time);
    maybe('elevation_range', c.elevation_range);
    maybe('getting_there', c.getting_there);
    maybe('practical_json', JSON.stringify(c.practical));
    maybe('activities_json', JSON.stringify(c.activities));
    maybe('related_json', JSON.stringify(c.related));
    // The seeded name for the valley destination is "Kathmandu"; the brief
    // and every piece of navigation call it the Kathmandu Valley.
    if (c.name && row.name !== c.name && row.auto_created === 0 && slug === 'kathmandu') {
      sets.push('name = ?');
      params.push(c.name);
    }
    if (!sets.length) continue;
    params.push(row.id);
    run(`UPDATE destinations SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  /* =======================================================================
     FAQS

     Answers are either verifiable facts about travelling and riding in Nepal,
     or they describe how this platform actually behaves — the cancellation
     answer quotes the refund tiers held in the cancellation_rules table
     rather than a number invented for the FAQ page, so the two cannot drift
     apart. Nothing here asserts a certification, an insurance policy or an
     evacuation arrangement that has not been supplied.
     ======================================================================= */
  const refundTiers = db
    .prepare('SELECT min_days_before_departure d, refund_percent p FROM cancellation_rules ORDER BY min_days_before_departure DESC')
    .all();
  const refundSentence = refundTiers.length
    ? refundTiers
        .map(t => (t.d > 0 ? `${t.p}% if you cancel ${t.d} or more days before departure` : `no refund inside ${refundTiers[refundTiers.length - 2]?.d ?? 7} days`))
        .join(', ') + '.'
    : 'The refund tiers are set out in full on the Booking Conditions page.';

  const FAQS = [
    ['difficulty', 'How do your difficulty levels work?',
      'Every adventure carries one overall level from 1 (Relaxed) to 5 (Tough), plus separate scores for the things that actually make a trip hard: fitness, technical skill and altitude. A trip can be 4/5 overall because of altitude while being technically straightforward, and the detail page shows all of it rather than hiding it behind a single number. The Difficulty Guide explains each level with examples.', null, null, 1],
    ['difficulty', 'I am fit but I have never ridden at altitude. Which trips suit me?',
      'Look for an altitude score of 2 or below and a maximum altitude under about 3,000 m — the Kathmandu Valley and Pokhara trips sit there. Fitness carries you a long way below 3,000 m and much less far above 4,000 m, where the limiting factor is how your body acclimatises rather than how hard you can push. Starting lower and coming back is the normal progression.', null, null, 2],
    ['difficulty', 'What happens if a trip turns out to be harder than I expected?',
      'Tell your guide early rather than late. On most itineraries there is a support vehicle or a shorter alternative for at least part of the day, and on teahouse routes there is usually the option of a rest day. What is not available is a quick exit from the middle of a remote circuit — that is why the detail page for a trip like Manaslu says so explicitly.', null, null, 3],

    ['fitness', 'How fit do I need to be?',
      'It depends on the trip, and the fitness score on each adventure page is the honest answer for that one. As a rule: level 1–2 suits anyone who exercises occasionally, level 3 expects you to be riding or walking regularly, and level 4–5 assumes consistent training and several hours of sustained effort day after day. Consecutive days are what catches people out, not any single day.', null, null, 1],
    ['fitness', 'Do I need previous mountain-bike experience?',
      'For the Kathmandu Valley and Pokhara trips, no — comfortable on a bike off-road is enough. For anything rated 3 or above technically you want real off-road experience, because the consequence of a mistake on an exposed Himalayan trail is different from the consequence at your local trail centre. Each adventure page states what it assumes.', 'mountain-biking', null, 2],

    ['equipment', 'Can I bring my own bike?',
      'Yes, and most people riding the longer trips do. Airlines treat bike bags differently and charges vary a lot, so check with yours before booking. Kathmandu is the only place in the country with reliable spares, so bring consumables specific to your bike — brake pads, a spare hanger, a tyre.', 'mountain-biking', null, 1],
    ['equipment', 'Is bike rental available?',
      'Rental is offered as an optional extra on trips where it is listed in the extras on that adventure’s page. What is available depends on the trip and the dates, so it is confirmed when you book rather than promised in advance.', 'mountain-biking', null, 2],
    ['equipment', 'What do I need to bring?',
      'Each adventure page carries its own essential and recommended equipment lists, because a two-day Pokhara trip and a twelve-day Manaslu traverse need very different kit. The short version: layers for a 20 °C temperature swing in a day, proper sun protection at altitude, and a helmet you trust.', null, null, 3],

    ['accommodation', 'Where will I sleep?',
      'Every adventure states its accommodation type — hotel, lodge, teahouse or camping — and the detail page explains what that means in practice on that route. In the hills that generally means village lodges and teahouses: clean, simple, twin rooms, shared bathrooms more often than not, and hot water that depends on the weather and the generator.', null, null, 1],
    ['accommodation', 'Can I have a single room?',
      'In the towns, usually. On the high teahouse routes, often not — rooms are allocated by what the lodge has when the group arrives, and above about 4,000 m a dormitory is sometimes the only option. If a single room matters to you, say so when you book so it can be checked rather than assumed.', null, null, 2],

    ['transport', 'How does transport work during the trip?',
      'Airport transfers and all transport named in the inclusions are arranged for you. Road journeys in Nepal are slower than the distance suggests — Kathmandu to Pokhara is 200 km and six to eight hours — and itineraries are built around that rather than against it.', null, null, 1],
    ['transport', 'What if a domestic flight is cancelled?',
      'Flights to Jomsom and Lukla are weather-dependent and cancel regularly; this is normal, not exceptional. Itineraries that depend on one build in spare days. If a cancellation still forces a change, your guide reorganises on the ground and you are told what changed and why.', null, null, 2],

    ['safety', 'What medical and emergency cover is in place?',
      'Guides carry a first-aid kit and a communication device, and group sizes are capped so there is always someone able to go with you if you need to go down. The specifics of emergency protocol, evacuation arrangements and medical cover for each region are being documented with High Route and are published on the Safety page as they are confirmed — we would rather that page be short and accurate than complete and assumed.', null, null, 1],
    ['safety', 'Do I need travel insurance?',
      'Yes, and it is a condition of booking rather than a suggestion. It must cover mountain activity at the maximum altitude of your trip and include helicopter evacuation and repatriation. Many standard policies exclude activity above 3,000 m or 4,000 m, which rules out most of what is on this site, so read the altitude clause specifically.', null, null, 2],
    ['safety', 'What happens if the weather changes the itinerary?',
      'The guide changes the itinerary. Snow closing a pass, a landslide on a road section or a cancelled mountain flight are all ordinary Himalayan conditions, and the plan is built with alternatives. You will not be taken over a high pass in bad conditions to keep a schedule.', null, null, 3],

    ['weather', 'When is the best time to come?',
      'October and November are the clearest and most settled months across most of the country, with March to May the second window — warmer, hazier, and the rhododendrons out. The June–September monsoon shuts down most high routes but not Upper Mustang, which sits in the rain shadow. The When to Visit page breaks this down month by month.', null, null, 1],
    ['weather', 'How cold does it get?',
      'At 4,000 m and above, expect below freezing overnight in the main season and a 20 °C swing between a sunny afternoon and a clear night. Down in Pokhara and the Kathmandu Valley it stays mild all winter. The equipment list on each adventure is built around that trip’s actual range.', null, null, 2],

    ['pricing', 'What is included in the price?',
      'Each adventure page lists inclusions, exclusions, mandatory charges and optional extras separately and in full. International flights, visa, travel insurance and personal equipment are excluded on every trip. Anything that is compulsory but charged separately — permits, park fees — appears under mandatory charges rather than being buried in the exclusions.', null, null, 1],
    ['pricing', 'What deposit do you take?',
      'The deposit for each adventure is shown on its dates and prices section, with the balance due before departure. The deposit figures currently in the system are placeholders pending confirmation by High Route and are flagged as such in the admin panel — treat the amount shown at checkout as the authority.', null, null, 2],
    ['pricing', 'Are there any charges I pay locally?',
      'Where a trip has them, they are listed as mandatory charges on its page. Permit and conservation-area fees are set by Nepali government bodies and change, so the current rate is confirmed at booking rather than printed here where it would go stale.', null, null, 3],

    ['booking', 'How do I book?',
      'Pick a departure date on the adventure page, which takes you through rider details, any extras and payment. You can also send an enquiry instead if you have questions first, or use Private Trips if you want the itinerary built around your group.', null, null, 1],
    ['booking', 'Do I need an account?',
      'Not to browse, filter or use the Adventure Finder — none of that asks for an email address. You do create an account as part of booking, so that you have somewhere to see your trip, your riders and your invoice afterwards.', null, null, 2],
    ['booking', 'Can you build a trip for my group?',
      'Yes — that is what Private Trips is for. Tell us the activity, the dates, roughly how long and how hard, and you get an itinerary and a price built for your group rather than a departure you have to fit into.', null, null, 3],

    ['cancellation', 'What is your cancellation policy?',
      `Refunds are tiered by how far out you cancel: ${refundSentence} The full terms, including what happens if High Route cancels a departure, are on the Booking Conditions page.`, null, null, 1],
    ['cancellation', 'What if you cancel the trip?',
      'If a departure is cancelled you are offered an alternative date or a full refund of what you have paid us. What that does not cover is anything you booked separately, which is the main reason travel insurance with cancellation cover is a condition of booking.', null, null, 2],

    ['general', 'How big are the groups?',
      'Every adventure states its own minimum and maximum, and the maximum is a cap rather than a target — most run smaller. Small groups are not only a nicer way to travel: they are the reason a lodge in a village of forty people can absorb a group at all.', null, null, 1],
    ['general', 'Who actually runs the trips?',
      'Nepali guides and a Nepali support team. The Guides page carries their profiles, their languages and their experience, and lists only the qualifications that have been verified rather than everything claimed.', null, null, 2],
  ];
  for (const [category, question, answer, activity, destination_slug, sort] of FAQS) {
    if (!get('SELECT id FROM faqs WHERE question = ?', [question])) {
      run(
        `INSERT INTO faqs (question, answer, category, activity, destination_slug, sort_order, published)
         VALUES (?,?,?,?,?,?,1)`,
        [question, answer, category, activity, destination_slug, sort]
      );
    }
  }

  /* =======================================================================
     IMPACT METRICS — structure only, no values

     Read the comment at the top of this file before adding a number here.
     Each row ships with value = NULL and evidenced = 0, which the Our Impact
     page renders as "not yet published" alongside a note naming what has to
     be supplied. Once an admin enters a figure AND ticks evidenced, it
     appears as a published fact. The `source` column records how it was
     measured, which is the difference between a figure and a claim.
     ======================================================================= */
  const YEAR = new Date().getFullYear();
  const METRICS = [
    ['local_supplier_spend', 'Spent with Nepali suppliers', 'EUR', 'local_economy',
      'The sum of local_supplier_spend_cents across every departure that ran this year. Needs each departure’s supplier invoices entered against it in the admin panel.', 1],
    ['guide_wages', 'Paid to guides and support team', 'EUR', 'local_economy',
      'From guide_wages_cents per departure. Payroll figures have to come from High Route.', 2],
    ['local_accommodation_nights', 'Nights in locally owned accommodation', 'nights', 'local_economy',
      'Counted per departure. Requires confirming which lodges on each route are locally owned, which is not something that can be inferred.', 3],
    ['nepali_staff_share', 'Share of the team who are Nepali', '%', 'local_economy',
      'A headcount High Route holds. Publish it as a count, not a percentage, if the team is small enough that a percentage would be misleading.', 4],
    ['community_contributions', 'Direct contributions to community projects', 'EUR', 'community',
      'From community_contribution_cents per departure, and only for contributions that actually reached a named recipient.', 1],
    ['community_partners', 'Community partners worked with', 'partners', 'community',
      'A list, not an estimate. Each partner needs to be named on the Our Impact page or the number means nothing.', 2],
    ['trail_contributions', 'Contributed to trail maintenance', 'EUR', 'conservation',
      'From trail_contribution_cents per departure. Needs the receiving organisation named.', 1],
    ['trail_days', 'Days of trail work supported', 'days', 'conservation',
      'Recorded per departure where the group or the operator funded trail work.', 2],
    ['average_group_size', 'Average group size', 'riders', 'environment',
      'Calculated from group_size across departures that ran. This one is derivable from booking data already in the system once departures are marked complete.', 1],
    ['transport_km', 'Road and air kilometres per traveller', 'km', 'environment',
      'From transport_km and transport_type per departure. Worth publishing precisely because it is the figure that does not flatter anyone.', 2],
    ['single_use_plastic', 'Single-use plastic avoided', 'litres', 'environment',
      'Only publishable if bottle refills are actually counted on trip. An estimate here would be exactly the kind of number the brief rules out.', 3],
  ];
  for (const [key, label, unit, dimension, notes, sort] of METRICS) {
    run(
      `INSERT INTO impact_metrics (year, metric_key, label, value, unit, dimension, notes, evidenced, sort_order, published)
       VALUES (?,?,?,NULL,?,?,?,0,?,1)
       ON CONFLICT(year, metric_key) DO NOTHING`,
      [YEAR, key, label, unit, dimension, notes, sort]
    );
  }
};
