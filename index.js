const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { nanoid } = require("nanoid/async");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// -------- DB SIMULATION --------
const dbFile = path.resolve("./db.json");
let dbData = {
  wallet: { balance: 450 },
  transactions: [],
  drivers: [
    {
      id: "1",
      name: "Ravi",
      car: "Dzire",
      rating: 4.7,
      available: true,
      location: { lat: 28.6139, lng: 77.209 },
    },
    {
      id: "2",
      name: "Amit",
      car: "WagonR",
      rating: 4.5,
      available: true,
      location: { lat: 28.6135, lng: 77.21 },
    },
    {
      id: "3",
      name: "Suresh",
      car: "Alto",
      rating: 4.2,
      available: true,
      location: { lat: 28.614, lng: 77.2085 },
    },
  ],
  rides: [],
  users: [],
};

// Load DB file
if (fs.existsSync(dbFile)) {
  dbData = JSON.parse(fs.readFileSync(dbFile));
}

async function saveDB() {
  fs.writeFileSync(dbFile, JSON.stringify(dbData, null, 2));
}

// -------- JWT --------
const JWT_SECRET = "dev-key";
function createToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, {
    expiresIn: "7d",
  });
}
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).send({ error: "No token" });
  try {
    const token = header.split(" ")[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).send({ error: "Invalid token" });
  }
}

// -------- ROOT --------
app.get("/", (req, res) => res.send("Taxi backend running!"));

// -------- AUTH --------
app.post("/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (dbData.users.find((u) => u.email === email))
    return res.status(400).send({ error: "Email exists" });
  const hash = await bcrypt.hash(password, 8);
  const user = { id: await nanoid(), name, email, password: hash };
  dbData.users.push(user);
  await saveDB();
  res.send({ token: createToken(user), user });
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = dbData.users.find((u) => u.email === email);
  if (!user) return res.status(401).send({ error: "Wrong email" });
  if (!(await bcrypt.compare(password, user.password)))
    return res.status(401).send({ error: "Wrong password" });
  res.send({ token: createToken(user), user });
});

// -------- WALLET --------
app.get("/wallet", auth, (req, res) => res.send(dbData.wallet));
app.post("/wallet/topup", auth, async (req, res) => {
  const { amount } = req.body;
  dbData.wallet.balance += amount;
  dbData.transactions.push({
    id: await nanoid(),
    type: "topup",
    amount,
    createdAt: new Date().toISOString(),
  });
  await saveDB();
  res.send({ ok: true, balance: dbData.wallet.balance });
});

// -------- TRANSACTIONS --------
app.get("/transactions", auth, (req, res) => res.send(dbData.transactions));

// -------- DRIVERS --------
app.get("/drivers", (req, res) => res.send(dbData.drivers));

// -------- RIDES --------
function calculateFare(from, to) {
  const distanceKm = Math.floor(Math.random() * 10) + 1;
  const ratePerKm = 15;
  return distanceKm * ratePerKm;
}
function estimateArrival(driver) {
  return Math.floor(Math.random() * 10) + 2; // 2-10 min
}
function simulateDriverLocation(driver) {
  driver.location.lat += (Math.random() - 0.5) / 1000;
  driver.location.lng += (Math.random() - 0.5) / 1000;
  return driver.location;
}

app.post("/rides/request", auth, async (req, res) => {
  const { from, to } = req.body;
  const fare = calculateFare(from, to);
  if (dbData.wallet.balance < fare)
    return res.status(400).send({ error: "Insufficient balance" });

  const driver = dbData.drivers.find((d) => d.available);
  if (!driver) return res.status(400).send({ error: "No drivers available" });

  driver.available = false;
  const ride = {
    id: await nanoid(),
    userId: req.user.id,
    driver,
    from,
    to,
    fare,
    status: "requested",
    createdAt: new Date().toISOString(),
    etaMinutes: estimateArrival(driver),
  };
  dbData.wallet.balance -= fare;
  dbData.transactions.push({
    id: await nanoid(),
    type: "ride",
    amount: fare,
    createdAt: new Date().toISOString(),
  });
  dbData.rides.push(ride);
  await saveDB();
  res.send(ride);
});

app.get("/rides", auth, (req, res) => {
  const userRides = dbData.rides.filter((r) => r.userId === req.user.id);
  res.send(userRides);
});

app.post("/rides/complete/:rideId", auth, async (req, res) => {
  const { rating } = req.body;
  const ride = dbData.rides.find((r) => r.id === req.params.rideId);
  if (!ride) return res.status(404).send({ error: "Ride not found" });

  ride.status = "completed";
  ride.driver.available = true;

  // update driver rating
  if (rating) {
    const d = dbData.drivers.find((dr) => dr.id === ride.driver.id);
    d.rating =
      (d.rating * (d.ridesCompleted || 0) + rating) /
      ((d.ridesCompleted || 0) + 1);
    d.ridesCompleted = (d.ridesCompleted || 0) + 1;
  }
  await saveDB();
  res.send({ ok: true, ride });
});

app.post("/rides/cancel/:rideId", auth, async (req, res) => {
  const ride = dbData.rides.find((r) => r.id === req.params.rideId);
  if (!ride) return res.status(404).send({ error: "Ride not found" });
  if (ride.status !== "requested")
    return res.status(400).send({ error: "Cannot cancel" });

  ride.status = "cancelled";
  ride.driver.available = true;
  dbData.wallet.balance += ride.fare; // refund
  await saveDB();
  res.send({ ok: true, ride });
});

app.get("/rides/driver-location/:rideId", auth, (req, res) => {
  const ride = dbData.rides.find((r) => r.id === req.params.rideId);
  if (!ride) return res.status(404).send({ error: "Ride not found" });
  const location = simulateDriverLocation(ride.driver);
  res.send({ driverLocation: location, etaMinutes: ride.etaMinutes });
});

// -------- START SERVER --------
const PORT = 5001;
app.listen(PORT, () => console.log("Taxi backend running on port", PORT));
