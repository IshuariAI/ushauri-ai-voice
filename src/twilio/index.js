const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const connectDB = require("../db");
const setupEnglishBot = require("../twilio/english");
require("dotenv").config();

const app = express();

connectDB();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Ushauri Backend is working!");
});

setupEnglishBot(app);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
