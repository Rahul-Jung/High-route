const {DatabaseSync}=require('node:sqlite');const fs=require('fs');
const out='E:/Route/high-route-mtb/.vercel-api-stage/backend/seed-snapshot.db';
try{fs.unlinkSync(out)}catch{}
const src=new DatabaseSync('E:/Route/high-route-mtb/backend/data/highroute.db',{readOnly:true});
src.exec(`VACUUM INTO '${out}'`);src.close();
const db=new DatabaseSync(out);db.exec('PRAGMA foreign_keys=OFF');
const rv=db.prepare("select sql from sqlite_master where name='reviews'").get().sql;console.log(rv.slice(0,300));
for(const t of ['admins','booking_addons','booking_riders','bookings','custom_proposals','custom_request_events','custom_request_payments','custom_requests','email_verifications','enquiries','finder_leads','invoices','newsletter_subscribers','notifications','refunds','riders','sessions','gps_pings','trip_updates','emergency_alerts'])
  db.exec('DELETE FROM '+t);
db.exec("UPDATE departures SET seats_booked=0, status='open' WHERE status IN ('few_spaces','full')");
db.exec("UPDATE departures SET seats_booked=0");
db.exec('PRAGMA journal_mode=DELETE');
console.log(db.prepare('select (select count(*) from tours) t,(select count(*) from departures) d,(select count(*) from riders) r,(select count(*) from admins) a').get());
db.close();
