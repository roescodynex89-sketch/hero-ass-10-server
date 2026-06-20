const express = require("express");
const app = express();
const dotenv = require("dotenv");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

dotenv.config();
const port = process.env.PORT || 5000;
 const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// CORS Config
app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
  }),
);


// WEBHOOK


app.post(
  "/api/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET 
      );
    } catch (err) {
      console.error("❌ Webhook error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      
     
      const { userId, planName } = session.metadata; 

    
   
      const db = client.db("ArtHubDB");
      
      try {
        await db
          .collection("") 
          .updateOne(
            { _id: userId }, 
            { $set: { plan: planName, paymentStatus: "paid" } }
          );
        console.log(`✅ Plan updated for user: ${userId}`);
      } catch (dbErr) {
        console.error("❌ Database update failed:", dbErr);
        return res.status(500).json({ error: "Database error" });
      }
    }

    res.json({ received: true });
  }
);








// middleware
app.use(express.json());
app.use(cookieParser());

// DB client
const uri = process.env.MONGO_DB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server
    await client.connect();

    // 🗄️ Database & Collections
    const db = client.db("ArtHubDB");
    const artworksCollection = db.collection("artworks");
    const salesCollection = db.collection("sales");
    const usersCollection = db.collection("profiles"); 

    // =========================================================================
    // 📊 1. OVERVIEW STATS ENDPOINT
    // =========================================================================
    app.get("/api/artist/stats/:email", async (req, res) => {
      try {
        const email = req.params.email;

        // ১. মোট আপলোড করা আর্ট
        const totalArtworks = await artworksCollection.countDocuments({
          artistEmail: email,
        });

        // ২. এই আর্টিস্টের মোট কয়টি আর্ট বিক্রি হয়েছে
        const totalSoldItems = await salesCollection.countDocuments({
          artistEmail: email,
        });

        // ৩. টোটাল সেলস অ্যামাউন্ট (আর্নিং যোগফল)
        const salesData = await salesCollection
          .find({ artistEmail: email })
          .toArray();
        const totalSalesAmount = salesData.reduce(
          (sum, item) => sum + Number(item.price || 0),
          0,
        );

        // ৪. আর্টিস্টের বর্তমান প্ল্যান (ইউজার কালেকশন থেকে রিড করা হচ্ছে)
        const artistUser = await usersCollection.findOne({ email: email });
        const currentPlan = artistUser?.plan || "Free Plan";

        res.send({
          totalArtworks,
          totalSoldItems,
          totalSalesAmount,
          currentPlan,
        });
      } catch (error) {
        res.status(500).send({ message: "Error fetching artist stats", error });
      }
    });

    // =========================================================================
    // 🎨 2. MANAGE ARTWORKS (CRUD OPERATIONS)
    // =========================================================================

    // READ: একটি নির্দিষ্ট আর্টিস্টের সব আর্ট লিস্ট দেখা (Manage Artworks Table)
    app.get("/api/artworks/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const result = await artworksCollection
          .find({ artistEmail: email })
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error fetching artworks" });
      }
    });

    // READ SINGLE: এডিট করার জন্য নির্দিষ্ট একটি আর্টের ডাটা তুলে আনা
    app.get("/api/artwork/single/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await artworksCollection.findOne(query);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error fetching artwork details" });
      }
    });

    // CREATE: নতুন আর্টওয়ার্ক যোগ করা (Frontend থেকে imgBB url সহ ডাটা আসবে এখানে)
    app.post("/api/artworks", async (req, res) => {
      try {
        const artwork = req.body; // { title, description, price, category, imageUrl, artistEmail, artistName }
        const result = await artworksCollection.insertOne(artwork);
        res.status(201).send(result);
      } catch (error) {
        res.status(500).send({ message: "Error creating artwork" });
      }
    });

    // UPDATE: এক্সিস্টিং আর্টওয়ার্ক এডিট বা আপডেট করা
    app.put("/api/artwork/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: {
            title: req.body.title,
            description: req.body.description,
            price: Number(req.body.price),
            category: req.body.category,
            imageUrl: req.body.imageUrl, // নতুন ইমেজ আপলোড করলে সেটা সেট হবে
          },
        };
        const result = await artworksCollection.updateOne(filter, updatedDoc);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error updating artwork" });
      }
    });

    // DELETE: আর্টওয়ার্ক ডিলিট করা
    app.delete("/api/artwork/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await artworksCollection.deleteOne(query);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error deleting artwork" });
      }
    });

    // =========================================================================
    // 💰 3. SALES HISTORY ENDPOINT
    // =========================================================================
    app.get("/api/artist/sales/:email", async (req, res) => {
      try {
        const email = req.params.email;
        // আর্টিস্টের ইমেইল দিয়ে ফিল্টার করে সেলস হিস্ট্রি টেবিল ডাটা আনা
        const result = await salesCollection
          .find({ artistEmail: email })
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error fetching sales history" });
      }
    });

    // =========================================================================
    // 👤 4. PROFILE MANAGEMENT ENDPOINT
    // =========================================================================
    app.put("/api/user/profile/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const filter = { email: email };
        const updatedProfile = {
          $set: {
            name: req.body.name,
            image: req.body.image, // প্রোফাইল পিকচার url
            bio: req.body.bio,
            phoneNumber: req.body.phoneNumber,
          },
        };
        // যদি ইউজার ডাটাবেজে না থাকে তবে upsert করবে
        const options = { upsert: true };
        const result = await usersCollection.updateOne(
          filter,
          updatedProfile,
          options,
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error updating profile" });
      }
    });

    // =========================================================================
    // 🌐 PUBLIC ARTWORKS ENDPOINTS (BROWSE & DETAILS)
    // =========================================================================

    // ১. GET ALL ARTWORKS (সার্চ, ফিল্টার, সর্টিং এবং পেজিনেশন সহ)
    app.get("/api/public/artworks", async (req, res) => {
      try {
        const { search, category, minPrice, maxPrice, sortBy } = req.query;
        let query = {};

        // 🔍 সার্চ লজিক (Title অথবা Artist Name দিয়ে)
        if (search) {
          query.$or = [
            { title: { $regex: search, $options: "i" } },
            { artistName: { $regex: search, $options: "i" } },
          ];
        }

        // 🗂️ ক্যাটাগরি ফিল্টার
        if (category) {
          query.category = category;
        }

        // 💰 প্রাইজ রেঞ্জ ফিল্টার
        if (minPrice || maxPrice) {
          query.price = {};
          if (minPrice) query.price.$gte = Number(minPrice);
          if (maxPrice) query.price.$lte = Number(maxPrice);
        }

        // 📊 সর্টিং লজিক
        let sortOptions = {};
        if (sortBy === "newest") {
          sortOptions._id = -1; // অথবা তোমার তৈরি করা createdAt ডেট দিয়ে
        } else if (sortBy === "price-low") {
          sortOptions.price = 1;
        } else if (sortBy === "price-high") {
          sortOptions.price = -1;
        } else {
          sortOptions._id = -1; // Default newest
        }

        const result = await artworksCollection
          .find(query)
          .sort(sortOptions)
          .toArray();
        res.send(result);
      } catch (error) {
        res
          .status(500)
          .send({ message: "Error fetching public artworks", error });
      }
    });

    // ২. GET SINGLE ARTWORK DETAILS BY ID
    app.get("/api/public/artworks/:id", async (req, res) => {
      try {
        const id = req.params.id;

        // মঙ্গোডিবির আইডি ভ্যালিড কিনা চেক করা
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid Artwork ID" });
        }

        const query = { _id: new ObjectId(id) };
        const artwork = await artworksCollection.findOne(query);

        if (!artwork) {
          return res.status(404).send({ message: "Artwork not found" });
        }

        res.send(artwork);
      } catch (error) {
        res
          .status(500)
          .send({ message: "Error fetching artwork details", error });
      }
    });

    // Database Ping
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Keep connection alive
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("ArtHub Backend Server is Running Smoothly! 🚀");
});

app.listen(port, () => {
  console.log(`ArtHub app listening on port ${port}`);
});
