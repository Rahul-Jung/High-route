/* ===========================================================================
   MIGRATION 004 — the destination page gets something to put on it.
   ===========================================================================

   The destination pages shipped with an intro, a best-time paragraph, an
   elevation range, a getting-there paragraph and four practical notes. That
   is enough for a stub and not enough for a page: in a browser it read as a
   hero image above three short blocks and a trip list.

   This adds the structured content a destination page actually needs, and
   seeds it for the seven written-up destinations.

   WHAT IS IN HERE AND WHAT IS NOT
   -------------------------------
   Everything seeded below is geography, logistics, seasonality and culture:
   facts about a place that are true whether or not anybody books anything.

   Deliberately absent, because nobody has supplied them and the alternative
   is inventing them:

     - permit FEES and park entry charges. Which permits a region needs is a
       fact; what they cost changes by nationality, by season and by year,
       and a wrong number on a planning page is worse than no number. Every
       permit note says which permits are needed and that we confirm the
       current cost when quoting.
     - flight and transfer prices, and journey times stated more precisely
       than the roads deserve.
     - lodge names, bed counts, star ratings or any claim about a specific
       property.
     - visitor numbers, trail statistics and anything that would need
       measuring rather than knowing.
     - photographs. The gallery is assembled from images that already exist
       in this database and are already attributed to a trip in that region,
       plus whatever an admin adds in the panel. Nothing is stock-sourced
       here to fill a grid.

   Where a rule is genuinely unstable — Nepal has changed the guide
   requirement for independent trekkers more than once — the text says it is
   checked before each departure rather than stating a version of it that may
   have expired.

   IDEMPOTENCE
   -----------
   Columns are added only if absent. Content is written only where the field
   is still empty, so an admin who edits any of this in the panel keeps their
   edit through every subsequent boot. That is the whole reason the seeding
   is written as a per-field "fill if blank" rather than an UPDATE … SET.
   =========================================================================== */
'use strict';

module.exports = function migrate(db) {
  const colsOf = (table) =>
    db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

  /* ---------------- columns ---------------- */
  {
    const cols = colsOf('destinations');
    const add = (col, def) => {
      if (!cols.includes(col)) db.exec(`ALTER TABLE destinations ADD COLUMN ${col} ${def}`);
    };
    // Short labels. `best_time` and `elevation_range` are paragraphs — right
    // for a page, useless in a card or a glance cell, which is why these two
    // exist alongside them rather than replacing them.
    add('best_months', 'TEXT');
    add('altitude_summary', 'TEXT');
    // Structured blocks, each rendered by its own component.
    add('at_a_glance_json', "TEXT NOT NULL DEFAULT '[]'");   // [{label, value, note}]
    add('highlights_json', "TEXT NOT NULL DEFAULT '[]'");    // [{title, text}]
    add('seasons_json', "TEXT NOT NULL DEFAULT '[]'");       // [{label, months, note, best}]
    add('sections_json', "TEXT NOT NULL DEFAULT '[]'");      // [{heading, body}]
    // Named prose fields, each with its own panel on the page. These could
    // all have been `sections_json` entries; they are columns because the
    // page gives each one a different treatment and because "does this
    // destination have a permits note yet" is a question worth being able
    // to ask in SQL.
    add('permits', 'TEXT');
    add('getting_around', 'TEXT');
    add('health_notes', 'TEXT');
    add('culture', 'TEXT');
  }

  /* ---------------- seeding ---------------- */

  const dests = db.prepare('SELECT * FROM destinations').all();
  const bySlug = new Map(dests.map((d) => [d.slug, d]));

  /** Writes a field only if the destination does not have one yet.
   *  An empty JSON array counts as "not yet" for the list fields. */
  const fill = (slug, field, value) => {
    const row = bySlug.get(slug);
    if (!row) return;
    const current = row[field];
    const isList = field.endsWith('_json');
    const empty = isList
      ? !current || current === '[]' || current === 'null'
      : current === null || current === undefined || String(current).trim() === '';
    if (!empty) return;
    db.prepare(`UPDATE destinations SET ${field} = ? WHERE id = ?`)
      .run(isList ? JSON.stringify(value) : value, row.id);
  };

  const seed = (slug, data) => {
    if (!bySlug.has(slug)) return;
    Object.keys(data).forEach((field) => fill(slug, field, data[field]));
  };

  /* ===================================================================
     KATHMANDU VALLEY
     =================================================================== */
  seed('kathmandu', {
    best_months: 'October – April',
    altitude_summary: '1,300 – 2,782 m',
    at_a_glance_json: [
      { label: 'Elevation', value: '1,300 – 2,782 m', note: 'Valley floor to Phulchowki summit' },
      { label: 'Best months', value: 'Oct – Apr', note: 'Rideable year-round' },
      { label: 'Permits', value: 'None for the rim', note: 'Park entry where a route enters Shivapuri Nagarjun' },
      { label: 'Altitude risk', value: 'None', note: 'Nothing here is high enough to cause altitude illness' },
      { label: 'Accommodation', value: 'Hotels and guesthouses', note: 'You sleep in the valley and ride out each day' },
      { label: 'Typical trip', value: '3 – 5 days' },
    ],
    highlights_json: [
      {
        title: 'The rim, not the ring road',
        text: 'The valley is a bowl with a rideable edge: Nagarkot, Shivapuri, Phulchowki, Chandragiri, Champadevi. '
          + 'The traffic and the dust are on the floor; almost everything worth riding is on the way up and out of it.',
      },
      {
        title: 'Seven World Heritage sites in one valley',
        text: 'The Durbar Squares of Kathmandu, Patan and Bhaktapur, Swayambhu, Boudhanath, Pashupatinath and '
          + 'Changu Narayan are all inside a 20 km circle. Several sit directly on riding and walking routes.',
      },
      {
        title: 'Newar towns, not a theme park',
        text: 'Bhaktapur, Kirtipur, Sankhu, Panauti and Khokana are working Newar towns with brick-and-timber '
          + 'architecture, courtyard temples and their own festival calendar. Panauti and Khokana in particular see '
          + 'a fraction of the visitors the Durbar Squares do.',
      },
      {
        title: 'Where acclimatisation starts',
        text: 'At 1,300 m the valley does nothing for high-altitude acclimatisation, but the rim climbs do reach '
          + '2,000–2,700 m. Two or three days here before a high trip is about jet lag, bike setup and getting '
          + 'used to the heat, not about altitude.',
      },
    ],
    seasons_json: [
      { label: 'Autumn', months: 'Oct – Nov', best: 1, note: 'The clearest air of the year and the best mountain views from the rim. Also the busiest month in the valley and the peak of the festival calendar — Dashain and Tihar both fall here, and the city largely stops for them.' },
      { label: 'Winter', months: 'Dec – Feb', best: 1, note: 'Cold mornings, dry trails and reliable riding. Haze and dust build through late winter as an inversion sits over the valley, so the mountain views fade even on cloudless days.' },
      { label: 'Spring', months: 'Mar – May', note: 'Warm and increasingly hazy, with dust on the trails and poor air on the valley floor. The rim is still good riding, and rhododendron comes out on Phulchowki and Shivapuri.' },
      { label: 'Monsoon', months: 'Jun – Sep', note: 'Hot, green and wet. The clay trails are genuinely slick and some of the steeper rim descents are not a sensible plan. Mornings are often clear and the valley is at its greenest.' },
    ],
    permits: 'Nothing is needed to ride or walk the valley itself. Routes that enter Shivapuri Nagarjun National Park '
      + 'pay an entry fee at the gate, and a few monuments and World Heritage squares charge separate admission for '
      + 'foreign visitors. We arrange the park entry as part of the trip and tell you which monument fees you will meet '
      + 'on the way; we do not quote the amounts here because they are set by other bodies and change without notice.',
    getting_around: 'Tribhuvan International Airport is on the valley floor, twenty to forty minutes from most of '
      + 'Thamel and Patan depending on traffic. Within the valley we move by vehicle to the start of a ride and meet you '
      + 'at the end of it, which avoids the ring road entirely. Taxis and ride-hailing apps work well for your own time; '
      + 'the local buses are cheap, slow and not worth it with luggage.',
    health_notes: 'There is no altitude risk here. The real health issue is air quality: between roughly December and '
      + 'April an inversion traps vehicle and brick-kiln emissions over the valley floor, and the dust on unpaved roads '
      + 'is constant. If you have asthma or another respiratory condition, bring what you normally use and expect to need '
      + 'it. The rim is noticeably cleaner than the floor, which is one more reason the routes head uphill early.',
    culture: 'The valley is the Newar heartland, and it reads differently from the hill and mountain regions: dense '
      + 'towns rather than scattered villages, courtyard architecture, Hindu and Buddhist practice layered in the same '
      + 'spaces rather than separated. Festivals are frequent and genuinely disruptive — a chariot procession will close '
      + 'a route and a national holiday will empty a town. We plan around the calendar rather than through it, and tell '
      + 'you when a trip overlaps something worth seeing.',
    sections_json: [
      {
        heading: 'What the riding is actually like',
        body: 'Steep, loose, and rooted in the forest sections — the valley rim is a lot more technical than its modest '
          + 'altitude suggests. Climbs are mostly on jeep track and old pilgrim road; the descents are singletrack, stone '
          + 'staircase and farm path, often with a cliff on one side and a terrace drop on the other.\n\n'
          + 'The surface changes completely with the season. Dry-season dust turns the same corner that was tacky in '
          + 'October into a skating rink by April, and the monsoon clay will stop a bike dead. Any itinerary here is '
          + 'written with alternatives for the day it has actually rained.',
      },
      {
        heading: 'Why most trips start and end here',
        body: 'Every international arrival lands in the valley, so it is where a trip is assembled and taken apart: bikes '
          + 'built, fit checked, permits collected, duffels repacked. Two days at the start is not padding — it is the '
          + 'difference between finding a problem with your brakes in Kathmandu and finding it on a descent in Mustang.\n\n'
          + 'It is also the one place in Nepal where a mechanical is solvable the same day. Beyond the valley you are '
          + 'carrying what you brought.',
      },
    ],
  });

  /* ===================================================================
     POKHARA
     =================================================================== */
  seed('pokhara', {
    best_months: 'October – April',
    altitude_summary: '800 – 1,600 m',
    at_a_glance_json: [
      { label: 'Elevation', value: '800 – 1,600 m', note: 'Phewa Lake to the Sarangkot ridge' },
      { label: 'Best months', value: 'Oct – Apr', note: 'Low enough to ride all winter' },
      { label: 'Permits', value: 'None lakeside', note: 'ACAP permit once a route enters the conservation area' },
      { label: 'Altitude risk', value: 'None', note: 'Subtropical; the highest ridge is under 1,700 m' },
      { label: 'Accommodation', value: 'Lakeside hotels', note: 'Guesthouses on the longer hill loops' },
      { label: 'Typical trip', value: '2 – 4 days' },
    ],
    highlights_json: [
      {
        title: 'An 8,000 m skyline from 800 m',
        text: 'Pokhara is the only place in Nepal where you see the high Himalaya from a subtropical lakeside. '
          + 'Machhapuchhre looks close enough to touch and Annapurna South sits behind it — about 7,000 vertical '
          + 'metres of relief in one view, which is among the steepest on earth.',
      },
      {
        title: 'Sarangkot at first light',
        text: 'The ridge above the lake is the standard sunrise viewpoint and the standard first climb. It is a real '
          + 'climb — roughly 800 m from the lake — on a mix of road and track, and the descent off the back is the '
          + 'reason people ride it rather than drive up.',
      },
      {
        title: 'Riding when the high country is shut',
        text: 'At 800 m the hills around Pokhara are rideable in December and January, when Thorong La is under snow '
          + 'and the Manaslu circuit is closed. For a winter trip this is where Nepal still works.',
      },
      {
        title: 'Short enough to be a real weekend',
        text: 'Everything here is within a day of the lake: Begnas and Rupa, the World Peace Pagoda ridge, the '
          + 'Panchase foothills, the Seti gorge. It is the one Nepali destination that does not need two weeks to be '
          + 'worth the flight.',
      },
    ],
    seasons_json: [
      { label: 'Autumn', months: 'Oct – Nov', best: 1, note: 'Clear, warm and the most reliable mountain views of the year. Busy on the lakeside and the one time of year to book accommodation ahead.' },
      { label: 'Winter', months: 'Dec – Feb', best: 1, note: 'Mild days, cold clear mornings, dry trails. The best winter riding in Nepal and the quietest the lakeside gets.' },
      { label: 'Spring', months: 'Mar – May', note: 'Hot by April, and the haze that builds over the lowlands takes the mountains away for days at a time. Early starts become necessary rather than optional.' },
      { label: 'Monsoon', months: 'Jun – Sep', note: 'Pokhara is one of the wettest places in Nepal. The trails are greasy, the leeches are real and the mountains are behind cloud — but mornings often stay clear and the hills are extraordinarily green.' },
    ],
    permits: 'The lake, the ridges above it and the Begnas side need no permit. Any route that crosses into the '
      + 'Annapurna Conservation Area needs an ACAP permit, which we arrange in Pokhara before you start. We will tell '
      + 'you if the route you have booked crosses that line; we do not publish the fee because ACAP sets it and it has '
      + 'changed more than once.',
    getting_around: 'A twenty-five minute flight from Kathmandu, or six to eight hours by road depending on traffic and '
      + 'roadworks on the Prithvi Highway. The flight is short, cheap and frequently the better use of a day; the drive '
      + 'follows the Trishuli and is more interesting than it sounds. There is also a direct road in from the Indian '
      + 'border at Sunauli. Everything in town is walkable or a five-minute taxi.',
    health_notes: 'No altitude risk and no acclimatisation needed. It is subtropical, so the problems here are heat, '
      + 'dehydration and sun — a 30°C day at 800 m with 800 m of climbing takes more water than people expect. Mosquitoes '
      + 'are present at this elevation and leeches are common in the monsoon forest sections.',
    culture: 'Pokhara is a Gurung and Magar hill region with a long and complicated connection to foreign armies — '
      + 'Gurkha recruitment ran through here for generations, and it shows in the villages, the remittance economy and '
      + 'the number of families with somebody abroad. The lakeside itself is a tourism town and makes no pretence '
      + 'otherwise; the hills above it, twenty minutes up, are not.',
    sections_json: [
      {
        heading: 'What the riding is actually like',
        body: 'Long, sustained climbs on jeep track and village road, and descents that are mostly flowing singletrack '
          + 'through terrace and forest. Less technical than the Kathmandu rim and considerably more rideable in the '
          + 'wet, because the soil drains instead of turning to clay.\n\n'
          + 'The gradients are the thing to respect. Nepali hill paths go straight up a spur rather than switchbacking '
          + 'across it, so a 700 m climb is a short distance and a long hour.',
      },
      {
        heading: 'Using it as a staging post',
        body: 'Pokhara is where most Annapurna and Mustang trips actually begin: the ACAP permits are issued here, the '
          + 'Jomsom flight leaves from here, and the road up the Kali Gandaki starts here. A day either side of a high '
          + 'trip is worth building in — one to sort permits and bikes, one to come down to warm air and a lake at the '
          + 'end of it.',
      },
    ],
  });

  /* ===================================================================
     ANNAPURNA
     =================================================================== */
  seed('annapurna', {
    best_months: 'Oct – Nov · Mar – May',
    altitude_summary: '800 – 5,416 m',
    at_a_glance_json: [
      { label: 'Elevation', value: '800 – 5,416 m', note: 'Besisahar to Thorong La' },
      { label: 'Best months', value: 'Oct – Nov, Mar – May', note: 'Thorong La is often snow-closed Dec – Feb' },
      { label: 'Permits', value: 'ACAP + TIMS', note: 'Both arranged before you start' },
      { label: 'Altitude risk', value: 'High', note: 'A 5,416 m pass; acclimatisation days are not optional' },
      { label: 'Accommodation', value: 'Teahouses', note: 'Lodges the whole way; no camping needed' },
      { label: 'Typical trip', value: '10 – 16 days' },
    ],
    highlights_json: [
      {
        title: 'Thorong La, 5,416 m',
        text: 'The high point of the circuit and of most people’s year. It is crossed in the dark and early because '
          + 'the wind gets up by mid-morning, and it is the single reason the itinerary has acclimatisation days built '
          + 'into it rather than bolted on.',
      },
      {
        title: 'The deepest gorge in the world',
        text: 'The Kali Gandaki runs between Dhaulagiri (8,167 m) and Annapurna I (8,091 m) with the river at around '
          + '2,500 m — a depth no other gorge matches. The descent down it on the far side of the pass is the longest '
          + 'continuous drop on the circuit.',
      },
      {
        title: 'Every climate zone in one route',
        text: 'Subtropical terrace and banana at Besisahar, rhododendron and pine through the middle hills, juniper and '
          + 'scrub at Manang, and bare high desert at the pass. Few routes anywhere pass through this many ecological '
          + 'zones without a flight.',
      },
      {
        title: 'Muktinath and Manang',
        text: 'Muktinath is a pilgrimage site for both Hindus and Buddhists, and busy with Nepali and Indian pilgrims '
          + 'who have come by road rather than on foot. Manang at 3,519 m is the acclimatisation stop, and the '
          + 'afternoon altitude talk there is worth going to.',
      },
    ],
    seasons_json: [
      { label: 'Autumn', months: 'Oct – Nov', best: 1, note: 'The clearest and most settled window, and the busiest. October is the single most crowded month on the circuit; the second half of November is quieter, colder and often just as clear.' },
      { label: 'Winter', months: 'Dec – Feb', note: 'Clear, cold and very quiet at low and middle altitude. Thorong La is frequently closed by snow and cannot be relied on, so a winter trip here is a lower-valley trip by design rather than a failed crossing.' },
      { label: 'Spring', months: 'Mar – May', best: 1, note: 'Warmer, hazier, and the rhododendron forests below 3,500 m are at their best. The pass is usually open from late March. Afternoon cloud build-up is normal by May.' },
      { label: 'Monsoon', months: 'Jun – Sep', note: 'The lower valleys are wet, leech-prone and at real risk of landslides on the road sections — which is the serious problem, because much of the approach is now road. Upper Mustang, over the watershed, stays dry; the Annapurna side does not.' },
    ],
    permits: 'Two permits: an Annapurna Conservation Area (ACAP) permit and a TIMS card. We arrange both in Kathmandu '
      + 'or Pokhara before departure and carry the paperwork. Checkpoints along the route do inspect them.\n\n'
      + 'Nepal’s rules on trekking without a licensed guide have changed more than once in recent years, and the '
      + 'version in force at the time of your trip is the one that matters. We confirm the current requirement before '
      + 'every departure rather than quoting a rule here that may have lapsed. We do not publish permit fees: they are '
      + 'set by ACAP and the government, vary by nationality, and are confirmed when we quote.',
    getting_around: 'Drive from Kathmandu or Pokhara to Besisahar for the eastern approach, or to Beni and up the Kali '
      + 'Gandaki for the western one. Pokhara is the more useful end to finish at, and Jomsom has an airstrip with a '
      + 'short, weather-dependent flight to Pokhara that is a genuinely useful escape route.\n\n'
      + 'The road matters more than it used to. Jeep track now reaches Manang on one side and well above Jomsom on the '
      + 'other, so parts of the classic circuit are a road with vehicles on it. The NATT trails exist to keep walkers '
      + 'and riders off that road where there is an alternative, and we use them wherever there is one.',
    health_notes: 'Acute mountain sickness is the main risk on this route and the reason its shape is what it is. The '
      + 'standard pattern — a rest day at Manang around 3,500 m, a staged approach to the pass, and crossing it early — '
      + 'exists because the pass is 5,416 m and the valley floor at the start is under 1,000 m.\n\n'
      + 'Going down is the treatment, and on the Manang side it is a long way down. We carry a pulse oximeter and a '
      + 'first-aid kit, and any trip that crosses the pass has a plan for turning somebody around and taking them back '
      + 'the way they came. There is a seasonal aid post at Manang run by the Himalayan Rescue Association.',
    culture: 'The circuit climbs out of Hindu hill-farming country into Tibetan-influenced Buddhist villages, and you '
      + 'can watch it happen over a few days: terraced rice and buffalo below, barley and yak above, the temples '
      + 'changing to gompas somewhere around Chame. Manang and the villages above it are Gurung and Manangi, with a '
      + 'long trading history over the passes into Tibet.',
    sections_json: [
      {
        heading: 'What the ground is actually like',
        body: 'Below Chame the circuit is mostly jeep track and old mule trail, with long climbs and some genuinely '
          + 'exposed sections cut into the gorge wall. Above Manang it is high, dry and rocky, and the altitude does the '
          + 'work rather than the gradient.\n\n'
          + 'On a bike the pass itself is mostly a hike-a-bike: the last few hundred metres to Thorong La are loose '
          + 'rock and snow patch at an altitude where nobody is pedalling. The descent to Muktinath is the pay-off and '
          + 'is very long. Anyone who tells you the whole circuit is rideable has not been over it.',
      },
      {
        heading: 'Where you sleep and what you eat',
        body: 'Teahouses the entire way, which means you carry no camping kit and no food. Rooms are simple, twin-share, '
          + 'and get colder and barer as you climb — above Manang expect an unheated room and a dining room with a stove '
          + 'that is lit in the evening.\n\n'
          + 'Food is dal bhat, noodles, fried rice and increasingly whatever the lodge thinks trekkers want. It is '
          + 'carried up by mule and porter above the roadhead, which is why the same plate costs more at 4,000 m than at '
          + '1,000 m, and why there is no meaningful vegetarian penalty up here — most of it already is.',
      },
      {
        heading: 'The honest downside',
        body: 'This is the most popular long route in Nepal and in October it feels like it. Lodges fill, the pass has a '
          + 'queue on a good morning, and the road has taken some of the quiet off the lower half. None of that makes it '
          + 'a bad route — it is still one of the great ones — but if solitude is the point, Manaslu is the answer and '
          + 'this is not.',
      },
    ],
  });

  /* ===================================================================
     MUSTANG
     =================================================================== */
  seed('mustang', {
    best_months: 'March – early November',
    altitude_summary: '2,700 – 4,200 m',
    at_a_glance_json: [
      { label: 'Elevation', value: '2,700 – 4,200 m', note: 'Jomsom to the highest passes' },
      { label: 'Best months', value: 'Mar – early Nov', note: 'Works through the monsoon — it is in the rain shadow' },
      { label: 'Permits', value: 'Restricted area + ACAP', note: 'Licensed guide and a minimum of two travellers' },
      { label: 'Altitude risk', value: 'Moderate', note: 'Starts at 2,700 m, so acclimatisation begins on arrival' },
      { label: 'Accommodation', value: 'Village guesthouses', note: 'Simple lodges in walled villages' },
      { label: 'Typical trip', value: '9 – 14 days' },
      { label: 'Wind', value: 'Daily, from late morning', note: 'Strong up-valley wind; days are planned around it' },
    ],
    highlights_json: [
      {
        title: 'Lo Manthang',
        text: 'A walled town at around 3,800 m that was the capital of the Kingdom of Lo, with a royal palace, '
          + 'fifteenth-century monasteries and a street plan that has not changed much. It is the destination of the '
          + 'route and worth more than one day.',
      },
      {
        title: 'The rain shadow',
        text: 'Mustang sits north of the main Himalayan crest, so the monsoon that shuts the rest of Nepal mostly '
          + 'misses it. That makes it the one serious high-altitude destination here that works in July and August.',
      },
      {
        title: 'Cave cities',
        text: 'The cliffs around Chhoser and Luri hold hundreds of man-made caves cut high into the rock, some of them '
          + 'many storeys and some still holding wall paintings. Several are reachable and a few are open to visitors.',
      },
      {
        title: 'Tibetan Buddhist culture, continuous',
        text: 'Upper Mustang was closed to outsiders until 1992 and the restricted-area rules still limit numbers. '
          + 'The language is a Tibetan dialect, the monasteries are working ones, and the Tiji festival in spring is '
          + 'a three-day event set by the monastic calendar rather than for visitors.',
      },
    ],
    seasons_json: [
      { label: 'Spring', months: 'Mar – May', best: 1, note: 'Cold at the start and warming fast. Tiji falls in this window, on dates set each year by the monastery, and the valley is busier for it. The wind is at its most persistent in spring.' },
      { label: 'Monsoon', months: 'Jun – Sep', best: 1, note: 'The reason to come. Occasional rain reaches over the crest but the valley stays broadly dry and rideable while the rest of Nepal is shut. The approach through the Annapurna side is the weak link — the road up the Kali Gandaki can be cut by slides.' },
      { label: 'Autumn', months: 'Oct – early Nov', best: 1, note: 'Clear, cold and settled, with the best light of the year on the cliffs. The window closes quickly through November as the high villages start to empty.' },
      { label: 'Winter', months: 'Late Nov – Feb', note: 'Clear and very cold. Many families move south to Pokhara or Kathmandu for the winter and a good proportion of the villages and lodges simply close, so a winter trip is not a quieter version of the same route — it is a different and much emptier place.' },
    ],
    permits: 'Upper Mustang above Kagbeni is a restricted area. It needs a restricted-area permit in addition to the '
      + 'ACAP permit, and the rules attached to it are the strict kind: you must travel with a licensed guide and there '
      + 'is a minimum of two travellers on the permit. A solo traveller cannot be permitted, which is why a single '
      + 'booking here is matched to a departure rather than run alone.\n\n'
      + 'The restricted-area permit is priced per person for a fixed number of days with a per-day charge beyond it. We '
      + 'do not publish those figures: they are set by the government, have been revised, and the live number goes in '
      + 'your quote. Lower Mustang — Jomsom, Marpha, Kagbeni — needs only the ACAP permit.',
    getting_around: 'Most trips fly or drive to Pokhara, then either take the short mountain flight to Jomsom or drive '
      + 'up the Kali Gandaki. The flight is weather-dependent and cancels; the drive is long, rough above Beni, and '
      + 'exposed to monsoon landslides.\n\n'
      + 'Above Jomsom there is a jeep road most of the way to Lo Manthang. It is a road in the Mustang sense — '
      + 'riverbed, loose rock, river crossings — and it carries occasional traffic. The older trails above it are '
      + 'better travelling and we use them where they exist.',
    health_notes: 'The trip starts at 2,700 m, so unlike the Annapurna circuit there is no gradual approach — you arrive '
      + 'already at altitude. The itinerary builds in a short day and an early night at Jomsom for that reason, and the '
      + 'climb to Lo Manthang is staged rather than direct.\n\n'
      + 'The other two issues are both about the air rather than the altitude: it is extremely dry, and the wind is '
      + 'relentless from late morning. Dehydration and cracked skin are near-universal, and sun at this elevation with '
      + 'no cloud and pale rock is severe. Going down is still the treatment for altitude illness, and from Lo Manthang '
      + 'that means a long day back to Jomsom and the airstrip.',
    culture: 'Mustang is culturally Tibetan and has been for centuries — it was an independent kingdom, then a '
      + 'principality within Nepal whose royal title was formally ended in 2008. The language spoken is a Tibetan '
      + 'dialect, Amchi medicine is still practised, and the monasteries at Lo Manthang, Ghar Gompa and Luri are '
      + 'working religious sites rather than monuments.\n\n'
      + 'Because the area was closed until 1992 and is still capped by permit, the places you pass through have not been '
      + 'reshaped by visitors in the way the Annapurna and Khumbu trails have. That is worth not spoiling: ask before '
      + 'photographing people, take shoes off in a gompa, and do not hand things to children.',
    sections_json: [
      {
        heading: 'What the ground is actually like',
        body: 'High desert. Loose rock, dust, riverbed, and old trade trails cut into canyon walls, with almost no '
          + 'vegetation to hold any of it together. The colours — red, grey, ochre cliffs under a sky with no moisture '
          + 'in it — are the reason people describe this as the most visually extraordinary place in Nepal.\n\n'
          + 'For riders it is rough rather than technical: long, exposed sections, sustained climbs, and descents on a '
          + 'surface that moves. The wind is a factor in the itinerary rather than a detail, because an exposed traverse '
          + 'at 3,800 m into a 40 km/h headwind is a different proposition from the same traverse at eight in the '
          + 'morning.',
      },
      {
        heading: 'Where you sleep and what you eat',
        body: 'Village guesthouses, simple and cold, in walled settlements with no insulation and no central heating. '
          + 'The dining room has a stove; the bedroom does not. A proper sleeping bag is not optional kit here even '
          + 'though the accommodation is indoors.\n\n'
          + 'Food is dal bhat, Tibetan bread, thukpa and whatever the village grows — apples and apricots in season, and '
          + 'Marpha on the way in is known for both. Everything else comes up the valley by jeep or mule.',
      },
      {
        heading: 'Why this is the monsoon answer',
        body: 'From June to September most Himalayan routes are wet, leeched, cloud-covered and at risk of landslides. '
          + 'Mustang is north of the crest and gets a fraction of that rain, so it stays dry, clear and rideable.\n\n'
          + 'The catch is honest and worth knowing before you book: getting there crosses the wet side. The road up the '
          + 'Kali Gandaki and the Jomsom flight are both exposed to monsoon weather, so a July trip needs spare days at '
          + 'the front and back for the approach, not for the route itself.',
      },
    ],
  });

  /* ===================================================================
     LANGTANG
     =================================================================== */
  seed('langtang', {
    best_months: 'October – April',
    altitude_summary: '1,500 – 3,870 m',
    at_a_glance_json: [
      { label: 'Elevation', value: '1,500 – 3,870 m', note: 'Syabrubesi to Kyanjin Gompa' },
      { label: 'Best months', value: 'Oct – Apr', note: 'Holds up in the shoulder months better than the high circuits' },
      { label: 'Permits', value: 'National park + TIMS', note: 'Langtang National Park entry permit' },
      { label: 'Altitude risk', value: 'Moderate', note: 'Under 4,000 m on the valley route; higher on the day peaks' },
      { label: 'Accommodation', value: 'Teahouses', note: 'Rebuilt lodges the length of the valley' },
      { label: 'Typical trip', value: '6 – 9 days' },
    ],
    highlights_json: [
      {
        title: 'The closest high valley to Kathmandu',
        text: 'One rough road day from the capital and you are at the trailhead. No internal flight, no four-day '
          + 'approach — which makes Langtang the best option in Nepal when the time available is a week rather than a '
          + 'fortnight.',
      },
      {
        title: 'Forest, then glacier',
        text: 'The lower valley is dense oak, rhododendron and bamboo with langur monkeys in it; by Kyanjin Gompa at '
          + '3,870 m you are in a glacial basin under Langtang Lirung. The transition happens in two days.',
      },
      {
        title: 'Tserko Ri',
        text: 'A long day-hike from Kyanjin to around 4,980 m, with the whole Langtang Himal in view from the top. '
          + 'It is the acclimatisation day and the high point of most itineraries here.',
      },
      {
        title: 'The Tamang Heritage Trail',
        text: 'A lower, warmer loop through Tamang villages to the west, often added to the valley route. It stays '
          + 'under 3,000 m, which makes it a genuinely different kind of day rather than more of the same.',
      },
    ],
    seasons_json: [
      { label: 'Autumn', months: 'Oct – Nov', best: 1, note: 'Clear and settled, with the best views and the most people. Still far quieter than Annapurna or the Khumbu in the same weeks.' },
      { label: 'Winter', months: 'Dec – Feb', best: 1, note: 'Cold but workable — the valley route tops out under 4,000 m, so it stays open when the high passes do not. Snow on the upper valley and some lodges closed. Tserko Ri may be out.' },
      { label: 'Spring', months: 'Mar – Apr', best: 1, note: 'The rhododendron through the lower forest is the reason to come in spring, and it is genuinely spectacular. Warm, increasingly hazy, and the valley is at its greenest by late April.' },
      { label: 'Monsoon', months: 'Jun – Sep', note: 'Wet forest, leeches, and cloud sitting in the valley. The bigger problem is the road: the drive from Kathmandu is rough at the best of times and slides close it in and after monsoon.' },
    ],
    permits: 'A Langtang National Park entry permit and a TIMS card, both arranged in Kathmandu before you leave. '
      + 'Checkpoints at Dhunche and in the valley do check them. As on the Annapurna routes, the rule about travelling '
      + 'with a licensed guide has been revised more than once and we confirm the current version before each '
      + 'departure. Permit fees are set by the park and the government and go in your quote rather than on this page.',
    getting_around: 'Six to eight hours by road from Kathmandu to Syabrubesi, through Trisuli and Dhunche. The road is '
      + 'rough at the far end, the drop-offs are real, and landslides are common in and after the monsoon — this drive '
      + 'is the least comfortable part of the trip and worth knowing about in advance.\n\n'
      + 'Beyond Syabrubesi it is all on foot or on the bike. There is no airstrip and no road up the valley, which is '
      + 'also what keeps it quiet.',
    health_notes: 'The valley route stays under 4,000 m, which makes it a reasonable first high-altitude trip. The day '
      + 'peaks are a different matter: Tserko Ri reaches about 4,980 m and Kyanjin Ri is similar, so the acclimatisation '
      + 'day at Kyanjin is there for a reason and the climb is done after it rather than on arrival.\n\n'
      + 'Evacuation is slower here than on the Annapurna or Khumbu trails — there is no road in the valley and '
      + 'helicopter extraction is weather-dependent. Going down on foot to the roadhead is a long day and a half from '
      + 'the top of the valley, and any plan here accounts for that.',
    culture: 'Langtang is a Tamang valley with strong Tibetan Buddhist practice, and the April 2015 earthquake hit it '
      + 'harder than almost anywhere in Nepal: a co-seismic landslide and ice avalanche destroyed Langtang village '
      + 'almost entirely and killed a large part of its population along with visitors who were there.\n\n'
      + 'The valley has been rebuilt, largely by the families who lived in it, and it is open and working. The '
      + 'memorials on the site of the old village are there for people who lost relatives, not as a viewpoint. Walking '
      + 'through is welcome; treating it as a stop on a tour is not.',
    sections_json: [
      {
        heading: 'What the ground is actually like',
        body: 'The valley path is a well-made trail with a lot of stone step in the forest section, climbing steadily '
          + 'beside the Langtang Khola. Above the treeline it opens into a broad glacial valley with easier walking and '
          + 'much thinner air.\n\n'
          + 'On a bike the forest section is the interesting part — rooted, stepped singletrack under canopy, slick when '
          + 'wet — and the upper valley is a fast, open, high-altitude ride. There is a fair amount of carrying on the '
          + 'steps, and the descent back out is the best part of the week.',
      },
      {
        heading: 'Where you sleep and what you eat',
        body: 'Teahouses the whole way, almost all of them rebuilt since 2015 and several noticeably better built than '
          + 'what they replaced. Twin rooms, shared bathrooms, a stove in the dining room in the evening.\n\n'
          + 'Food is the standard hill menu — dal bhat, noodle soup, fried rice, potatoes — with the Kyanjin cheese '
          + 'factory as the local oddity worth trying. Everything above Syabrubesi is carried in.',
      },
    ],
  });

  /* ===================================================================
     MANASLU
     =================================================================== */
  seed('manaslu', {
    best_months: 'Oct – Nov · Mar – May',
    altitude_summary: '700 – 5,106 m',
    at_a_glance_json: [
      { label: 'Elevation', value: '700 – 5,106 m', note: 'Soti Khola to Larkya La' },
      { label: 'Best months', value: 'Oct – Nov, Mar – May', note: 'Larkya La holds snow late and closes early' },
      { label: 'Permits', value: 'Restricted area + MCAP + ACAP', note: 'Licensed guide and a minimum of two travellers' },
      { label: 'Altitude risk', value: 'High', note: 'A 5,106 m pass with no road and no quick way out' },
      { label: 'Accommodation', value: 'Basic teahouses', note: 'Simpler and sparser than the Annapurna lodges' },
      { label: 'Typical trip', value: '14 – 18 days' },
      { label: 'Remoteness', value: 'The highest on this site', note: 'Days from a road in the middle section' },
    ],
    highlights_json: [
      {
        title: 'Larkya La, 5,106 m',
        text: 'A long, committing pass day from Dharamsala with a very early start, crossing from the Budhi Gandaki '
          + 'side into the Marsyangdi. It holds snow later than Thorong La and closes earlier, and there is no road '
          + 'anywhere near it.',
      },
      {
        title: 'The eighth highest mountain on earth',
        text: 'Manaslu is 8,163 m, and from Samagaun and Samdo you are close under its north side with nothing in the '
          + 'way. The Birendra glacial lake below it is a short walk from Samagaun.',
      },
      {
        title: 'The Budhi Gandaki gorge',
        text: 'The first days climb through a deep, steep-sided gorge on trails cut and bolted into the rock, with '
          + 'suspension bridges and a great deal of exposure. It is the most dramatic approach of any route here.',
      },
      {
        title: 'Genuinely quiet',
        text: 'The restricted-area permit caps numbers and the length puts people off, so this circuit sees a '
          + 'fraction of the Annapurna traffic. If being somewhere with nobody else in it is the point, this is the '
          + 'route on this site that delivers it.',
      },
    ],
    seasons_json: [
      { label: 'Autumn', months: 'Oct – Nov', best: 1, note: 'The main window and the most reliable one for the pass. Early October can still be unsettled; late November is cold and the pass becomes a gamble.' },
      { label: 'Spring', months: 'Mar – May', best: 1, note: 'A narrower window. Larkya La holds winter snow well into spring and an early-season crossing cannot be assumed — some years it is late April before it goes reliably.' },
      { label: 'Winter', months: 'Dec – Feb', note: 'The pass is closed and the high villages are largely empty. Not a circuit in winter; the lower gorge is walkable but it is not the trip.' },
      { label: 'Monsoon', months: 'Jun – Sep', note: 'Not viable. The Budhi Gandaki gorge is the wrong place to be in heavy rain — landslides take out sections of the trail most years — and the approach road is worse.' },
    ],
    permits: 'The most paperwork of any route on this site. A Manaslu restricted-area permit, a Manaslu Conservation '
      + 'Area (MCAP) permit, and an Annapurna Conservation Area (ACAP) permit because the circuit exits into the '
      + 'Annapurna area at Dharapani. The Tsum Valley side trip needs its own restricted-area permit on top.\n\n'
      + 'The restricted-area rules are strict: a licensed guide is required and there is a minimum of two travellers on '
      + 'the permit, so a solo booking is matched to a departure rather than run alone. The restricted-area permit is '
      + 'priced per person per day and is more expensive in the autumn window than outside it. We do not print those '
      + 'figures here — they are set by the government and revised — and the live numbers go in your quote.',
    getting_around: 'Road from Kathmandu to Soti Khola or Machha Khola, roughly eight to ten hours and rough at the far '
      + 'end, with the last stretch frequently requiring a 4WD. From there the circuit is on foot or on the bike for its '
      + 'whole length, finishing at Dharapani on the Annapurna circuit and driving out through Besisahar.\n\n'
      + 'There is no airstrip and no road in the middle of this route. That is the appeal and it is also the risk: for '
      + 'several days the only way out is the way you came or forwards over the pass.',
    health_notes: 'This is the most committing route on the site. The pass is 5,106 m, the approach is long, and in the '
      + 'middle section you are two or three days from any road in either direction. Helicopter evacuation is possible '
      + 'in good weather and is exactly as reliable as the weather is.\n\n'
      + 'The acclimatisation profile is better than Annapurna’s — the climb is gradual and there are rest days at '
      + 'Samagaun around 3,500 m — but the consequence of getting it wrong is higher because the escape is longer. Any '
      + 'trip here has a turn-around plan, and we will use it. There is no permanent aid post on the route.',
    culture: 'The upper valley is Nubri and the side valley is Tsum, both Tibetan-descended communities with their own '
      + 'dialects, and the border with Tibet is close enough that trade and family connections run across it. The '
      + 'monasteries at Mu Gompa and Rachen Gompa in the Tsum Valley are working religious sites in a valley that was '
      + 'closed to outsiders until 2008.\n\n'
      + 'Low down it is Gurung hill country and Hindu. As with the Annapurna circuit you can watch the culture change '
      + 'with the altitude, but here it happens over more days and with far fewer visitors in the way.',
    sections_json: [
      {
        heading: 'What the ground is actually like',
        body: 'Three distinct phases. The gorge: narrow trail, stone step, suspension bridge and a lot of exposure, '
          + 'climbing from 700 m over several days. The upper valley: open, high, dry and much easier walking around '
          + 'Samagaun and Samdo. The pass: a long rocky day at over 5,000 m with a steep, loose descent on the far side '
          + 'to Bimthang.\n\n'
          + 'On a bike this is the hardest thing on the site and the honest answer is that a meaningful part of it is '
          + 'carried. The gorge section has stairs and bridges that cannot be ridden, and nobody rides up to Larkya La. '
          + 'The Bimthang descent and the upper valley are the reasons to bring the bike.',
      },
      {
        heading: 'Where you sleep and what you eat',
        body: 'Teahouses, but noticeably more basic than the Annapurna ones — fewer of them, less choice, and at '
          + 'Dharamsala before the pass a single very simple place at around 4,460 m that is the only option. Expect '
          + 'unheated rooms, shared facilities and some nights in dormitory accommodation.\n\n'
          + 'Food is dal bhat and noodles, with the menu getting shorter as you go up. Everything above the roadhead is '
          + 'carried by mule or porter for days, which is worth remembering when something is not available.',
      },
      {
        heading: 'Who this is not for',
        body: 'If this is a first trek, or a first time at altitude, this is the wrong route and we will say so. The '
          + 'length, the remoteness and the pass all compound: there is no shortening it halfway through, no road to '
          + 'bail to, and no lodge with a spare day of comfort in it.\n\n'
          + 'Annapurna or Langtang first, then this. It will still be quiet when you come back.',
      },
    ],
  });

  /* ===================================================================
     EVEREST / KHUMBU
     =================================================================== */
  seed('everest', {
    best_months: 'Oct – Nov · Mar – May',
    altitude_summary: '2,845 – 5,545 m',
    at_a_glance_json: [
      { label: 'Elevation', value: '2,845 – 5,545 m', note: 'Lukla to Kala Patthar' },
      { label: 'Best months', value: 'Oct – Nov, Mar – May', note: 'October is the busiest month on the trail' },
      { label: 'Permits', value: 'National park + local municipality', note: 'Sagarmatha National Park and a Khumbu municipality permit' },
      { label: 'Altitude risk', value: 'Very high', note: 'Days above 4,000 m and a 5,545 m high point' },
      { label: 'Accommodation', value: 'Lodges', note: 'The best-developed lodge network in Nepal' },
      { label: 'Typical trip', value: '12 – 16 days' },
      { label: 'Activity', value: 'Walking', note: 'We publish no riding trips here — see below' },
    ],
    highlights_json: [
      {
        title: 'Kala Patthar at dawn',
        text: 'A 5,545 m hill above Gorak Shep, and the viewpoint that actually shows you Everest — from base camp '
          + 'itself the summit is hidden behind Nuptse. Cold, dark, slow and the reason most people come.',
      },
      {
        title: 'Tengboche',
        text: 'The largest gompa in the Khumbu at 3,867 m, with Ama Dablam directly behind it. The Mani Rimdu festival '
          + 'is held here in autumn on dates set by the monastic calendar.',
      },
      {
        title: 'Namche Bazaar',
        text: 'A town built into a horseshoe at 3,440 m, the trading centre of the Khumbu and the standard first '
          + 'acclimatisation stop. Saturday market, bakeries, and a great deal of gear for sale.',
      },
      {
        title: 'Sherpa country',
        text: 'The Khumbu is the Sherpa homeland and the mountaineering history is not a museum exhibit here — it is '
          + 'the families in the villages you walk through. The monasteries, mani walls and stupas on the route are in '
          + 'daily use.',
      },
    ],
    seasons_json: [
      { label: 'Autumn', months: 'Oct – Nov', best: 1, note: 'The clearest and most settled window. October is the single busiest month on any trail in Nepal and the Lukla flights and lodges are both under pressure; November is colder, quieter and often just as clear.' },
      { label: 'Spring', months: 'Mar – May', best: 1, note: 'The expedition season, so base camp is occupied and the trail is busy with it. Warmer and hazier than autumn, with afternoon cloud building by May.' },
      { label: 'Winter', months: 'Dec – Feb', note: 'Clear, extremely cold and very quiet. Many of the high lodges close, the passes are snowbound, and the high point of a trek becomes a matter of what is open rather than what is planned.' },
      { label: 'Monsoon', months: 'Jun – Sep', note: 'Cloud sits on the valley and hides the mountains, which removes the point. The Lukla flight is unreliable at the best of times and worse now. Not a season we would recommend for this region.' },
    ],
    permits: 'Two: a Sagarmatha National Park entry permit, and a permit issued by the Khumbu Pasang Lhamu Rural '
      + 'Municipality, which replaced the TIMS card for this region. Both are arranged before you fly in, and both are '
      + 'checked on the trail. Fees are set by the park and the municipality and go in your quote.\n\n'
      + 'As elsewhere in Nepal, the rule on trekking with a licensed guide has been revised more than once; we confirm '
      + 'the version in force before each departure.',
    getting_around: 'A mountain flight from Kathmandu to Lukla, or in the peak weeks from Ramechhap/Manthali, which is '
      + 'a four-to-five hour drive from Kathmandu before you even get to the airport. The flight is weather-dependent '
      + 'and cancels regularly in both directions — any itinerary here needs spare days at the end, and we build them '
      + 'in rather than hoping.\n\n'
      + 'There is an alternative overland approach from Jiri or Salleri that adds several days on foot and removes the '
      + 'flight risk entirely. Above Lukla everything moves on foot, by porter, by yak or by helicopter. There is no '
      + 'road anywhere in the Khumbu.',
    health_notes: 'This is the highest and most altitude-exposed region on the site. You land at 2,845 m, sleep above '
      + '4,000 m for several nights, and reach 5,545 m at Kala Patthar. Acute mountain sickness is common and the '
      + 'serious forms — pulmonary and cerebral oedema — do occur here every season.\n\n'
      + 'The itinerary shape is the mitigation: two nights at Namche, two at Dingboche, a strict ascent rate above that, '
      + 'and acclimatisation walks rather than rest days spent lying down. The Himalayan Rescue Association runs a '
      + 'seasonal aid post at Pheriche with a daily altitude talk, and it is worth your afternoon.\n\n'
      + 'Descent is the treatment and in the Khumbu it is walkable — which is one real advantage this region has over '
      + 'Manaslu. Helicopter evacuation is available and weather-dependent, and is a medical decision rather than a '
      + 'convenience.',
    culture: 'Sherpa, Tibetan Buddhist, and the single most visited mountain region in Nepal — all three at once. '
      + 'Namche has bakeries and gear shops because a very large number of people come through, and the villages above '
      + 'it are still villages. Walk clockwise around a stupa, pass mani walls on the left, and ask before '
      + 'photographing anyone. The mountain is called Sagarmatha in Nepali and Chomolungma in Tibetan and Sherpa, and '
      + 'both names predate the English one.',
    sections_json: [
      {
        heading: 'Why we publish no riding trips here',
        body: 'The Khumbu is a walking destination and we are not going to pretend otherwise to fill a category. The '
          + 'main trails are stone staircase, yak traffic and suspension bridge, inside a national park, at an altitude '
          + 'where carrying a bike is a serious undertaking. It can be done, and people have done it, but it is a '
          + 'mountaineering-adjacent stunt rather than a riding holiday.\n\n'
          + 'It is also somebody else’s path. These trails are the road network for the villages along them, and '
          + 'adding bikes to a stone staircase shared with loaded yaks and porters is a cost paid by the people who '
          + 'live there.\n\n'
          + 'If you want to ride in Nepal, Mustang and the Annapurna valleys are where the ground suits it. If you want '
          + 'to see Everest, come and walk — and we will put you with a guide who knows the valley.',
      },
      {
        heading: 'What the walking is actually like',
        body: 'Steep, stepped and relentless rather than technical. There is very little flat ground in the Khumbu; the '
          + 'trail descends to a river and climbs the other side repeatedly, and the famous climb from the Dudh Koshi '
          + 'to Namche is about 600 m of it on your second day.\n\n'
          + 'Above Dingboche the gradient eases and the altitude takes over. Distances become meaningless and the day '
          + 'is measured in hours and how you feel. The last stretch to Gorak Shep and up Kala Patthar is short on a '
          + 'map and long in practice.',
      },
      {
        heading: 'Where you sleep and what you eat',
        body: 'The best lodge network in Nepal, and the most crowded in October. Twin rooms, often with an attached '
          + 'bathroom as high as Dingboche, heated dining rooms burning yak dung, and hot water and charging both sold '
          + 'by the item above Namche.\n\n'
          + 'Long menus, and the standing advice from the aid post is still to eat vegetarian high up — meat is carried '
          + 'unrefrigerated for days from below Lukla. Dal bhat is the thing that is always fresh and always enough.',
      },
    ],
  });

  /* ------------------------------------------------------------------
     A destination with no page content is not published to the index
     (routes/content.js filters on `intro`), so the auto-created map pins —
     Chitwan among them — stay out of the way until somebody writes them up.
     Nothing is seeded for them here, deliberately: a page of invented
     content is worse than a destination that is only a pin on a map.
     ------------------------------------------------------------------ */
};
