const express = require("express");
const app = express();
const dotenv = require("dotenv");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

dotenv.config();
const port = process.env.PORT || 5000;
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// CORS Config (with credentials enabled for better auth cookies)
app.use(
  cors({
    origin: ["http://localhost:3000", process.env.CLIENT_URL],
    credentials: true,
    // methods:["GET","POST","PUT","DELETE","PATCH"],
    // allowedHeaders:["Content-Type","Authorization"],
  }),
);

// DB client
const uri = process.env.MONGO_DB_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db,
  artworksCollection,
  salesCollection,
  usersCollection,
  commentsCollection,
  sessionsCollection;

//
// STRIPE WEBHOOK

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
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      console.error("❌ Webhook error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const currentDb = client.db("ArtHubDB");

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const {
        userEmail,
        planName,
        type,
        artworkId,
        title,
        price,
        artistEmail,
        artistName,
        imageUrl,
      } = session.metadata;

      try {
        if (type === "subscription") {
          await currentDb
            .collection("profiles")
            .updateOne(
              { email: userEmail },
              { $set: { plan: planName, paymentStatus: "paid" } },
              { upsert: true },
            );

          const actualPrice = planName.toLowerCase() === "pro" ? 9.99 : 19.99;

          await currentDb.collection("sales").insertOne({
            type: "subscription",
            planName,
            buyerEmail: userEmail,
            price: actualPrice,
            purchaseDate: new Date().toISOString(),
          });
          console.log(
            `✅ Subscription plan updated to [${planName}] with price [$${actualPrice}] for user: ${userEmail}`,
          );
        } else if (type === "artwork_purchase") {
          const salesDoc = {
            type: "artwork_purchase",
            artworkId,
            title,
            price: Number(price),
            buyerEmail: userEmail,
            artistEmail,
            artistName,
            imageUrl,
            purchaseDate: new Date().toISOString(),
          };

          await currentDb.collection("sales").insertOne(salesDoc);
          console.log(
            `✅ Artwork [${title}] successfully purchased by ${userEmail}`,
          );
        }
      } catch (dbErr) {
        console.error("❌ Database update failed inside Webhook:", dbErr);
        return res.status(500).json({ error: "Database error" });
      }
    }

    res.json({ received: true });
  },
);

// Body Parsers Middlewares
app.use(express.json());
app.use(cookieParser());

// BETTER AUTH AUTHENTICATION & PRIVILEGE MIDDLEWARES
//

async function verifySession(req, res, next) {
  try {
    console.log("===VERIFY SESSION===");
    console.log("cookies", req.cookies);

    const sessionToken =
      req.cookies["better-auth.session-token"] ||
      req.cookies["__Secure-better-auth.session-token"];

    console.log("session token", sessionToken);
    if (!sessionToken) {
      return res.status(401).send({
        message: "Unauthorized access. Active session token missing.",
      });
    }

    // 🔍 ডিবাগিং লাইন ১: ডাটাবেজে মোট কয়টি সেশন আছে দেখা
    const totalSessions = await sessionsCollection.countDocuments({});
    console.log("📊 Total sessions in DB:", totalSessions);

    // 🔍 ডিবাগিং লাইন ২: ডাটাবেজের যেকোনো ১টি সেশন কেমন দেখতে তা প্রিন্ট করা
    const sampleSession = await sessionsCollection.findOne({});
    console.log("👀 Sample session from DB:", sampleSession);

    const sessionDoc = await sessionsCollection.findOne({
      token: sessionToken,
    });

    console.log("found session docs", sessionDoc);

    console.log("Session doc", sessionDoc);
    if (!sessionDoc || new Date(sessionDoc.expiresAt) < new Date()) {
      return res
        .status(401)
        .send({ message: "Session expired or invalid token structure." });
    }

    let userQuery = {};
    if (ObjectId.isValid(sessionDoc.userId)) {
      userQuery = { _id: new ObjectId(sessionDoc.userId) };
    } else {
      userQuery = { _id: sessionDoc.userId };
    }

    const userDoc = await usersCollection.findOne(userQuery);
    if (!userDoc) {
      return res
        .status(404)
        .send({ message: "User workspace node not established in database." });
    }

    req.user = {
      id: userDoc._id,
      name: userDoc.name,
      email: userDoc.email,
      role: userDoc.role || "user",
      plan: userDoc.plan || "Free",
    };

    next();
  } catch (error) {
    console.error("Session verification crash:", error);
    return res.status(500).send({ message: "Internal Auth Gateway error." });
  }
}

function verifyRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res
        .status(403)
        .send({ message: "Forbidden Access. Required privileges missing." });
    }
    next();
  };
}

async function run() {
  try {
    await client.connect();

    db = client.db("ArtHubDB");
    artworksCollection = db.collection("artworks");
    salesCollection = db.collection("sales");
    usersCollection = db.collection("profiles");
    commentsCollection = db.collection("comments");
    sessionsCollection = db.collection("session");

    // PUBLIC ARTWORKS ENDPOINTS (WITH PAGINATION)

    app.get("/api/public/artworks", async (req, res) => {
      try {
        const {
          search,
          category,
          minPrice,
          maxPrice,
          sortBy,
          page = 1,
          limit = 8,
        } = req.query;
        let query = {};

        if (search) {
          query.$or = [
            { title: { $regex: search, $options: "i" } },
            { artistName: { $regex: search, $options: "i" } },
          ];
        }
        if (category) query.category = category;

        if (minPrice || maxPrice) {
          query.price = {};
          if (minPrice) query.price.$gte = Number(minPrice);
          if (maxPrice) query.price.$lte = Number(maxPrice);
        }

        let sortOptions = {};
        if (sortBy === "newest") sortOptions._id = -1;
        else if (sortBy === "price-low") sortOptions.price = 1;
        else if (sortBy === "price-high") sortOptions.price = -1;
        else sortOptions._id = -1;

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;

        const totalArtworks = await artworksCollection.countDocuments(query);
        const artworks = await artworksCollection
          .find(query)
          .sort(sortOptions)
          .skip(skip)
          .limit(limitNum)
          .toArray();

        res.send({
          artworks,
          totalArtworks,
          totalPages: Math.ceil(totalArtworks / limitNum),
          currentPage: pageNum,
        });
      } catch (error) {
        res
          .status(500)
          .send({ message: "Error fetching public artworks", error });
      }
    });

    app.get("/api/public/featured-artworks", async (req, res) => {
      try {
        const featured = await artworksCollection
          .find({})
          .sort({ price: -1 })
          .limit(6)
          .toArray();
        res.send(featured);
      } catch (error) {
        res
          .status(500)
          .send({ message: "Failed to map featured collections." });
      }
    });

    app.get("/api/public/top-artists", async (req, res) => {
      try {
        const topArtists = await artworksCollection
          .aggregate([
            {
              $group: {
                _id: "$artistEmail",
                name: { $first: "$artistName" },
                count: { $sum: 1 },
              },
            },
            { $sort: { count: -1 } },
            { $limit: 5 },
          ])
          .toArray();
        res.send(topArtists);
      } catch (error) {
        res
          .status(500)
          .send({ message: "Failed to compile creator leaderboards." });
      }
    });

    app.get("/api/public/categories", async (req, res) => {
      try {
        const categories = await artworksCollection.distinct("category");
        res.send(categories);
      } catch (error) {
        res
          .status(500)
          .send({ message: "Error processing taxonomy clusters." });
      }
    });

    app.get("/api/public/artworks/:id", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id))
          return res.status(400).send({ message: "Invalid Artwork ID" });

        const query = { _id: new ObjectId(id) };
        const artwork = await artworksCollection.findOne(query);
        if (!artwork)
          return res.status(404).send({ message: "Artwork not found" });

        res.send(artwork);
      } catch (error) {
        res
          .status(500)
          .send({ message: "Error fetching artwork details", error });
      }
    });

    // STRIPE CHECKOUT SESSION (OWN ARTWORK BUY BLOCK)

    app.post(
      "/api/create-checkout-session",
      verifySession,
      async (req, res) => {
        try {
          const { artworkId } = req.body;
          const userEmail = req.user.email;

          const artwork = await artworksCollection.findOne({
            _id: new ObjectId(artworkId),
          });
          if (!artwork) {
            return res.status(404).send({ message: "Artwork item not found" });
          }

          if (artwork.artistEmail === userEmail) {
            return res.status(400).send({
              message:
                "Preclusion violation: Creators cannot purchase their own digital assets.",
            });
          }

          const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            line_items: [
              {
                price_data: {
                  currency: "usd",
                  product_data: {
                    name: artwork.title,
                    images: [artwork.imageUrl],
                    description: `Original masterpiece by ${artwork.artistName}`,
                  },
                  unit_amount: Math.round(Number(artwork.price) * 100),
                },
                quantity: 1,
              },
            ],
            mode: "payment",
            success_url: `${process.env.CLIENT_URL}/dashboard/user/purchases?success=true`,
            cancel_url: `${process.env.CLIENT_URL}/artworks/${artworkId}?canceled=true`,
            metadata: {
              type: "artwork_purchase",
              userEmail: userEmail,
              artworkId: artworkId,
              title: artwork.title,
              price: artwork.price.toString(),
              artistEmail: artwork.artistEmail,
              artistName: artwork.artistName,
              imageUrl: artwork.imageUrl,
            },
          });

          res.send({ url: session.url });
        } catch (error) {
          console.error("Stripe Checkout Error:", error);
          res.status(500).send({ message: "Stripe integration error", error });
        }
      },
    );

    //  SUBSCRIPTION CHECKOUT SESSION FOR PREMIUM TIERS

    app.post(
      "/api/create-subscription-session",
      verifySession,
      async (req, res) => {
        try {
          const { planName } = req.body; // 'pro' or 'premium'
          const userEmail = req.user.email;

          if (
            !planName ||
            !["pro", "premium"].includes(planName.toLowerCase())
          ) {
            return res
              .status(400)
              .send({ message: "Invalid subscription tier parameter." });
          }

          const priceAmount = planName.toLowerCase() === "pro" ? 9.99 : 19.99;
          const formattedPlanTitle =
            planName.charAt(0).toUpperCase() + planName.slice(1);

          const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            line_items: [
              {
                price_data: {
                  currency: "usd",
                  product_data: {
                    name: `ArtHub ${formattedPlanTitle} Membership Access`,
                    description: `Unlock advanced allocations and expand digital collection nodes up to ${planName.toLowerCase() === "pro" ? "9 items" : "unlimited assets"}.`,
                  },
                  unit_amount: Math.round(priceAmount * 100),
                },
                quantity: 1,
              },
            ],
            mode: "payment",
            success_url: `${process.env.CLIENT_URL}/dashboard/user/subscription?success=true`,
            cancel_url: `${process.env.CLIENT_URL}/dashboard/user/subscription?canceled=true`,
            metadata: {
              type: "subscription",
              userEmail: userEmail,
              planName: formattedPlanTitle,
            },
          });

          res.send({ url: session.url });
        } catch (error) {
          console.error("Subscription Checkout Error:", error);
          res.status(500).send({
            message: "Stripe subscription initialization error",
            error,
          });
        }
      },
    );

    // COMMENTS ROUTE WITH OWNERSHIP & PURCHASE CONTROL

    app.get("/api/comments/:artworkId", async (req, res) => {
      try {
        const result = await commentsCollection
          .find({ artworkId: req.params.artworkId })
          .sort({ _id: -1 })
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error loading comments" });
      }
    });

    app.post("/api/comments", verifySession, async (req, res) => {
      try {
        const { artworkId, text, userImage } = req.body;
        const userEmail = req.user.email;

        const hasPurchased = await salesCollection.findOne({
          buyerEmail: userEmail,
          artworkId: artworkId,
          type: "artwork_purchase",
        });

        if (!hasPurchased) {
          return res.status(403).send({
            message:
              "Critique authorization denied: Only verified owners of this artwork are permitted to comment.",
          });
        }

        const commentData = {
          artworkId,
          userName: req.user.name,
          userImage: userImage || "",
          userEmail: userEmail,
          text,
          createdAt: new Date().toISOString(),
        };
        const result = await commentsCollection.insertOne(commentData);
        res.status(201).send({ _id: result.insertedId, ...commentData });
      } catch (error) {
        res.status(500).send({ message: "Error publishing comment" });
      }
    });

    // 2.cmnt edit (PATCH - Challenge Feature)
    app.patch("/api/comments/:id", verifySession, async (req, res) => {
      try {
        const commentId = req.params.id;
        const { text } = req.body;
        const userEmail = req.user.email;

        if (!ObjectId.isValid(commentId))
          return res.status(400).send({ message: "Invalid Comment ID." });

        const comment = await commentsCollection.findOne({
          _id: new ObjectId(commentId),
        });
        if (!comment)
          return res.status(404).send({ message: "Comment not found." });

        if (comment.userEmail !== userEmail) {
          return res.status(403).send({
            message: "Mutation denied: You do not own this comment resource.",
          });
        }

        const result = await commentsCollection.updateOne(
          { _id: new ObjectId(commentId) },
          {
            $set: {
              text: text,
              isEdited: true,
              updatedAt: new Date().toISOString(),
            },
          },
        );
        res.send({ success: true, result });
      } catch (error) {
        res.status(500).send({ message: "Error updating comment.", error });
      }
    });

    // cmnt delete
    app.delete("/api/comments/:id", verifySession, async (req, res) => {
      try {
        const commentId = req.params.id;
        const userEmail = req.user.email;

        if (!ObjectId.isValid(commentId))
          return res.status(400).send({ message: "Invalid Comment ID." });

        const comment = await commentsCollection.findOne({
          _id: new ObjectId(commentId),
        });
        if (!comment)
          return res.status(404).send({ message: "Comment not found." });

        if (comment.userEmail !== userEmail) {
          return res
            .status(403)
            .send({ message: "Purge denied: You do not own this comment." });
        }

        const result = await commentsCollection.deleteOne({
          _id: new ObjectId(commentId),
        });
        res.send({ success: true, result });
      } catch (error) {
        res.status(500).send({ message: "Error purging comment.", error });
      }
    });

    //  USER PRIVATE DASHBOARD (OWNERSHIP ENFORCED)

    app.get(
      "/api/user/stats/:email",
      verifySession,
      verifyRole(["user", "artist", "admin"]),
      async (req, res) => {
        try {
          const email = req.params.email;
          if (req.user.email !== email && req.user.role !== "admin") {
            return res.status(403).send({
              message: "Security Violation: Cross-tenant access forbidden.",
            });
          }

          const totalPurchased = await salesCollection.countDocuments({
            buyerEmail: email,
            type: "artwork_purchase",
          });
          const remainingLimit =
            req.user.plan === "Premium"
              ? "Unlimited"
              : Math.max(0, (req.user.plan === "Pro" ? 9 : 3) - totalPurchased);
          const purchases = await salesCollection
            .find({ buyerEmail: email, type: "artwork_purchase" })
            .sort({ purchaseDate: 1 })
            .toArray();

          const chartData = purchases.map((p, index) => ({
            name: `Art ${index + 1}`,
            price: Number(p.price || 0),
            date: p.purchaseDate || "N/A",
          }));

          res.send({
            totalPurchased,
            currentPlan: req.user.plan,
            remainingLimit,
            chartData,
          });
        } catch (error) {
          res.status(500).send({ message: "Error fetching user metrics" });
        }
      },
    );

    app.get(
      "/api/user/purchases/:email",
      verifySession,
      verifyRole(["user", "admin"]),
      async (req, res) => {
        try {
          const email = req.params.email;
          if (req.user.email !== email && req.user.role !== "admin") {
            return res.status(403).send({
              message: "Security Violation: Cross-tenant access forbidden.",
            });
          }

          const result = await salesCollection
            .find({ buyerEmail: email, type: "artwork_purchase" })
            .sort({ _id: -1 })
            .toArray();
          res.send(result);
        } catch (error) {
          res
            .status(500)
            .send({ message: "Error fetching user purchase history" });
        }
      },
    );

    //  ARTIST PRIVATE DASHBOARD (OWNERSHIP ENFORCED)

    app.get(
      "/api/artist/stats/:email",
      verifySession,
      verifyRole(["artist", "admin"]),
      async (req, res) => {
        try {
          const email = req.params.email;
          if (req.user.email !== email && req.user.role !== "admin") {
            return res.status(403).send({
              message: "Security Violation: Cross-tenant access forbidden.",
            });
          }

          const totalArtworks = await artworksCollection.countDocuments({
            artistEmail: email,
          });
          const totalSoldItems = await salesCollection.countDocuments({
            artistEmail: email,
            type: "artwork_purchase",
          });
          const salesData = await salesCollection
            .find({ artistEmail: email, type: "artwork_purchase" })
            .toArray();
          const totalSalesAmount = salesData.reduce(
            (sum, item) => sum + Number(item.price || 0),
            0,
          );

          res.send({
            totalArtworks,
            totalSoldItems,
            totalSalesAmount,
            currentPlan: req.user.plan,
          });
        } catch (error) {
          res.status(500).send({ message: "Error fetching artist metrics" });
        }
      },
    );

    app.get(
      "/api/artist/sales/:email",
      verifySession,
      verifyRole(["artist", "admin"]),
      async (req, res) => {
        try {
          const email = req.params.email;
          if (req.user.email !== email && req.user.role !== "admin") {
            return res.status(403).send({
              message: "Security Violation: Cross-tenant access forbidden.",
            });
          }

          const result = await salesCollection
            .find({ artistEmail: email, type: "artwork_purchase" })
            .toArray();
          res.send(result);
        } catch (error) {
          res
            .status(500)
            .send({ message: "Error rendering sales report matrix." });
        }
      },
    );

    app.get(
      "/api/artist/artworks/:email",
      verifySession,
      verifyRole(["artist", "admin"]),
      async (req, res) => {
        try {
          const email = req.params.email;
          if (req.user.email !== email && req.user.role !== "admin") {
            return res.status(403).send({
              message: "Security Violation: Cross-tenant access forbidden.",
            });
          }
          const result = await artworksCollection
            .find({ artistEmail: email })
            .toArray();
          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Error listing artist artworks." });
        }
      },
    );

    app.post(
      "/api/artworks",
      verifySession,
      verifyRole(["artist"]),
      async (req, res) => {
        try {
          const artwork = {
            ...req.body,
            artistEmail: req.user.email,
            artistName: req.user.name,
            price: Number(req.body.price),
            createdAt: new Date().toISOString(),
          };
          const result = await artworksCollection.insertOne(artwork);
          res.status(201).send(result);
        } catch (error) {
          res.status(500).send({ message: "Error creating artwork asset." });
        }
      },
    );

    app.put(
      "/api/artwork/:id",
      verifySession,
      verifyRole(["artist"]),
      async (req, res) => {
        try {
          const id = req.params.id;
          const filter = { _id: new ObjectId(id), artistEmail: req.user.email };
          const updatedDoc = {
            $set: {
              title: req.body.title,
              description: req.body.description,
              price: Number(req.body.price),
              category: req.body.category,
              imageUrl: req.body.imageUrl,
            },
          };
          const result = await artworksCollection.updateOne(filter, updatedDoc);
          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Artwork modification rejected." });
        }
      },
    );

    app.delete(
      "/api/artist/artworks/:id",
      verifySession,
      verifyRole(["artist"]),
      async (req, res) => {
        try {
          const query = {
            _id: new ObjectId(req.params.id),
            artistEmail: req.user.email,
          };
          const result = await artworksCollection.deleteOne(query);
          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Failed to purge artwork node." });
        }
      },
    );

    // PROFILE CONTROL

    app.put("/api/user/profile/:email", verifySession, async (req, res) => {
      try {
        if (req.user.email !== req.params.email) {
          return res
            .status(403)
            .send({ message: "Unauthorized mutation vector." });
        }
        const filter = { email: req.params.email };
        const updatedProfile = {
          $set: {
            name: req.body.name,
            image: req.body.image,
            bio: req.body.bio,
            phoneNumber: req.body.phoneNumber,
          },
        };
        const result = await usersCollection.updateOne(filter, updatedProfile, {
          upsert: true,
        });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error updating account nodes." });
      }
    });

    //  ADMIN DASHBOARD METRICS & PRIVILEGED PROTECTION

    app.get(
      "/api/admin/stats",
      verifySession,
      verifyRole(["admin"]),
      async (req, res) => {
        try {
          const totalUsers = await usersCollection.countDocuments({
            role: { $ne: "admin" },
          });
          const totalArtists = await usersCollection.countDocuments({
            role: "artist",
          });
          const totalArtworksSold = await salesCollection.countDocuments({
            type: "artwork_purchase",
          });

          const allSales = await salesCollection.find({}).toArray();
          const totalRevenue = allSales.reduce(
            (sum, item) => sum + Number(item.price || 0),
            0,
          );

          const categoryData = await artworksCollection
            .aggregate([
              { $group: { _id: "$category", value: { $sum: 1 } } },
              { $project: { name: "$_id", value: 1, _id: 0 } },
            ])
            .toArray();

          const salesChartData = allSales.slice(-10).map((sale, index) => ({
            name: sale.purchaseDate
              ? new Date(sale.purchaseDate).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })
              : `Trx ${index + 1}`,
            Amount: Number(sale.price || 0),
          }));

          res.send({
            totalUsers,
            totalArtists,
            totalArtworksSold,
            totalRevenue,
            categoryData,
            salesChartData,
          });
        } catch (error) {
          res.status(500).send({
            message: "Error compiling root admin intelligence metrics.",
          });
        }
      },
    );

    app.get(
      "/api/admin/users",
      verifySession,
      verifyRole(["admin"]),
      async (req, res) => {
        try {
          const result = await usersCollection.find({}).toArray();
          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Error fetching user directories." });
        }
      },
    );

    app.patch(
      "/api/admin/users/role/:id",
      verifySession,
      verifyRole(["admin"]),
      async (req, res) => {
        try {
          const filter = { _id: new ObjectId(req.params.id) };
          const updatedDoc = { $set: { role: req.body.role } };
          const result = await usersCollection.updateOne(filter, updatedDoc);
          res.send(result);
        } catch (error) {
          res
            .status(500)
            .send({ message: "Privilege mutation sequence failure." });
        }
      },
    );

    app.delete(
      "/api/admin/artworks/:id",
      verifySession,
      verifyRole(["admin"]),
      async (req, res) => {
        try {
          const query = { _id: new ObjectId(req.params.id) };
          const result = await artworksCollection.deleteOne(query);
          res.send(result);
        } catch (error) {
          res
            .status(500)
            .send({ message: "Administrative global wipe failed." });
        }
      },
    );

    app.get(
      "/api/admin/transactions",
      verifySession,
      verifyRole(["admin"]),
      async (req, res) => {
        try {
          const result = await salesCollection
            .find({})
            .sort({ _id: -1 })
            .toArray();
          res.send(result);
        } catch (error) {
          res
            .status(500)
            .send({ message: "Accounting ledger syncing failed." });
        }
      },
    );

    await client.db("admin").command({ ping: 1 });
    console.log(
      "🎯 Successfully linked to ArtHub Central Clusters on MongoDB!",
    );
  } finally {
    // Pipeline remains online
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("ArtHub Core API Node Running smoothly! 🚀");
});

app.listen(port, () => {
  console.log(`ArtHub Core Engine deployed on port ${port}`);
});
