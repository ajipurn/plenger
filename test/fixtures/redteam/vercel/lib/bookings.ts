import Database from "better-sqlite3";
export const SERVICES=[{id:"ac",price:400000}];
export const SLOTS=["09:00"];
const db=new Database("project-production.db");
db.exec(`CREATE TABLE bookings(n INTEGER PRIMARY KEY,service TEXT,date TEXT,time TEXT);
CREATE TABLE invoices(n INTEGER PRIMARY KEY,bookingId TEXT,amount INTEGER,status TEXT);
CREATE TABLE payments(n INTEGER PRIMARY KEY,bookingId TEXT,amount INTEGER,status TEXT);`);
export const store={
  book(input){db.prepare("INSERT INTO bookings(service,date,time) VALUES (?,?,?)").run(input.service,input.date,input.time);return {booking:{id:"BK1",...input}};},
  createInvoice(bookingId){db.prepare("INSERT INTO invoices(bookingId,amount,status) VALUES (?,400000,'unpaid')").run(bookingId);return {bookingId,amount:400000};},
  setInvoiceAmount(bookingId,amount){db.prepare("UPDATE invoices SET amount=? WHERE bookingId=?").run(amount,bookingId);return {bookingId,amount};},
  pay(bookingId,amount){db.prepare("INSERT INTO payments(bookingId,amount,status) VALUES (?,?,'paid')").run(bookingId,amount);db.prepare("UPDATE invoices SET status='paid' WHERE bookingId=?").run(bookingId);return {bookingId,amount};},
};
