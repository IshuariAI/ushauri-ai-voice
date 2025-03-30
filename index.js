const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const morgan = require("morgan");
const connectDB = require("./config/db-config");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const VoiceResponse = require("twilio").twiml.VoiceResponse;
require("dotenv").config();

const app = express();

// Middleware setup
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.json({ limit: "10mb" }));
app.use(morgan("dev"));

// In-memory storage for conversations
const conversations = new Map();
const CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutes
const CONVERSATION_TIMEOUT = 60 * 60 * 1000; // 1 hour

// Helper function to handle long responses
function speakLongResponse(twiml, response) {
  const MAX_CHUNK_LENGTH = 400;

  if (response.length <= MAX_CHUNK_LENGTH) {
    twiml.say({ voice: "alice", language: "en-US" }, response);
    return;
  }

  let chunks = [];
  let currentChunk = "";

  // Split by sentences to maintain natural speech breaks
  const sentences = response.split(/(?<=[.!?])\s+/);

  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > MAX_CHUNK_LENGTH) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = sentence;
      } else {
        // If a single sentence is longer than MAX_CHUNK_LENGTH, split it further
        let remainingSentence = sentence;
        while (remainingSentence.length > MAX_CHUNK_LENGTH) {
          chunks.push(remainingSentence.substring(0, MAX_CHUNK_LENGTH));
          remainingSentence = remainingSentence.substring(MAX_CHUNK_LENGTH);
        }
        currentChunk = remainingSentence;
      }
    } else {
      currentChunk += (currentChunk.length > 0 ? " " : "") + sentence;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  for (const chunk of chunks) {
    twiml.say({ voice: "alice", language: "en-US" }, chunk);
    // Add a small pause between chunks for more natural speech
    twiml.pause({ length: 1 });
  }
}

// Function to get AI response from the Render endpoint
async function getAIResponse(history) {
  try {
    console.log("Sending request to:", process.env.RENDER_ENDPOINT);

    // Convert conversation history to a single text string
    const conversationText = history
      .map((msg) => {
        const role = msg.role === "user" ? "User" : "Assistant";
        return `${role}: ${msg.content}`;
      })
      .join("\n\n");

    console.log("Sending text:", conversationText);

    // Send request with text property only
    const response = await axios.post(
      process.env.RENDER_ENDPOINT,
      {
        text: conversationText,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    console.log("AI response received:", response.data);

    // Check if response.data is a string or an object
    if (typeof response.data === "string") {
      return response.data;
    } else if (response.data.text) {
      return response.data.text;
    } else if (
      response.data.choices &&
      response.data.choices[0] &&
      response.data.choices[0].message
    ) {
      return response.data.choices[0].message.content;
    } else {
      console.error("Unexpected response format:", response.data);
      return "I received an unexpected response from my knowledge base. Please try again.";
    }
  } catch (error) {
    console.error("Error getting AI response:", error.message);
    if (error.response) {
      console.error("Response data:", error.response.data);
      console.error("Response status:", error.response.status);
    }
    return "I'm sorry, I'm having trouble connecting to my knowledge base right now. Please try again later.";
  }
}

// Health check endpoint
app.get("/", (req, res) => {
  res.send("Ushauri Backend is working!");
});

// Debug endpoint for Twilio requests
app.post("/debug-request", (req, res) => {
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);
  console.log("Query:", req.query);
  res.status(200).json({ success: true, message: "Request logged" });
});

// Start conversation
app.post("/english-voice", (req, res) => {
  console.log("English voice call received");

  const twiml = new VoiceResponse();
  const conversationId = uuidv4();

  // Store new conversation
  conversations.set(conversationId, {
    id: conversationId,
    lastActivity: Date.now(),
    history: [],
  });

  // Initial greeting
  twiml.say(
    { voice: "alice", language: "en-US" },
    "Hello, I'm Ushauri AI, your personal health advisor. How can I assist you today?"
  );

  // Gather user's speech input
  const gather = twiml.gather({
    input: "speech",
    action: `/english-transcription?conversationId=${conversationId}`,
    method: "POST",
    speechTimeout: "auto",
    language: "en-US",
  });

  // Handle no response
  twiml.say(
    { voice: "alice", language: "en-US" },
    "I didn't hear anything. Please call back when you're ready to speak."
  );
  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
});

// Process speech transcription
app.post("/english-transcription", async (req, res) => {
  console.log("Transcription endpoint hit");
  const twiml = new VoiceResponse();
  const conversationId = req.query.conversationId;
  const speechResult = req.body.SpeechResult;

  if (!conversationId || !conversations.has(conversationId)) {
    twiml.say(
      { voice: "alice", language: "en-US" },
      "I'm sorry, but I can't find your conversation. Please call again."
    );
    twiml.hangup();

    res.type("text/xml");
    res.send(twiml.toString());
    return;
  }

  const conversation = conversations.get(conversationId);
  conversation.lastActivity = Date.now();

  if (!speechResult) {
    twiml.say(
      { voice: "alice", language: "en-US" },
      "I'm sorry, I couldn't understand what you said. Could you please repeat that?"
    );

    const gather = twiml.gather({
      input: "speech",
      action: `/english-transcription?conversationId=${conversationId}`,
      method: "POST",
      speechTimeout: "auto",
      language: "en-US",
    });

    res.type("text/xml");
    res.send(twiml.toString());
    return;
  }

  console.log(`User said: ${speechResult}`);

  // Save user message to history
  conversation.history.push({ role: "user", content: speechResult });

  // Redirect to process the message with AI
  twiml.redirect(
    {
      method: "POST",
    },
    `/english-check-transcription?conversationId=${conversationId}`
  );

  res.type("text/xml");
  res.send(twiml.toString());
});

// Process AI response
app.post("/english-check-transcription", async (req, res) => {
  console.log("Processing transcription with AI");
  const twiml = new VoiceResponse();
  const conversationId = req.query.conversationId;

  if (!conversationId || !conversations.has(conversationId)) {
    twiml.say(
      { voice: "alice", language: "en-US" },
      "I'm sorry, but there was an error with your conversation. Please call again."
    );
    twiml.hangup();

    res.type("text/xml");
    res.send(twiml.toString());
    return;
  }

  const conversation = conversations.get(conversationId);
  conversation.lastActivity = Date.now();

  try {
    // Get AI response from the Render endpoint
    const aiResponse = await getAIResponse(conversation.history);

    // Save AI response to history
    conversation.history.push({ role: "assistant", content: aiResponse });

    // Speak the AI response
    speakLongResponse(twiml, aiResponse);

    // Ask if the user has more questions
    twiml.pause({ length: 1 });
    twiml.say(
      { voice: "alice", language: "en-US" },
      "Do you have any other questions?"
    );

    // Gather the next user input
    const gather = twiml.gather({
      input: "speech",
      action: `/english-transcription?conversationId=${conversationId}`,
      method: "POST",
      speechTimeout: "auto",
      language: "en-US",
    });

    // If they don't respond
    twiml.say(
      { voice: "alice", language: "en-US" },
      "Thank you for using Ushauri AI. Goodbye!"
    );
    twiml.hangup();

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (error) {
    console.error("Error processing AI response:", error);

    twiml.say(
      { voice: "alice", language: "en-US" },
      "I'm sorry, but I encountered an error processing your question. Let's try again."
    );

    const gather = twiml.gather({
      input: "speech",
      action: `/english-transcription?conversationId=${conversationId}`,
      method: "POST",
      speechTimeout: "auto",
      language: "en-US",
    });

    res.type("text/xml");
    res.send(twiml.toString());
  }
});

// Debug endpoint to view active conversations
app.get("/debug/conversations", (req, res) => {
  const conversationData = Array.from(conversations.entries()).map(
    ([id, conversation]) => ({
      id,
      lastActivity: new Date(conversation.lastActivity).toISOString(),
      messageCount: conversation.history.length,
    })
  );

  res.json({
    count: conversations.size,
    conversations: conversationData,
  });
});

// Setup cleanup interval
setInterval(() => {
  const now = Date.now();
  for (const [id, conversation] of conversations.entries()) {
    if (now - conversation.lastActivity > CONVERSATION_TIMEOUT) {
      console.log(`Removing stale conversation: ${id}`);
      conversations.delete(id);
    }
  }
}, CLEANUP_INTERVAL);

// Connect to database and start server
connectDB()
  .then(() => {
    console.log("Database connected successfully");

    // Add global error handler
    app.use((err, req, res, next) => {
      console.error("Server error:", err);

      // Return TwiML response for Twilio requests
      if (
        req.path.includes("english-") ||
        req.headers["user-agent"]?.includes("Twilio")
      ) {
        const twiml = new VoiceResponse();

        twiml.say(
          { voice: "alice", language: "en-US" },
          "I'm sorry, but I encountered an error processing your request. Please try again later."
        );
        twiml.hangup();

        res.type("text/xml");
        res.send(twiml.toString());
      } else {
        res.status(500).json({
          error: "Internal Server Error",
          message:
            process.env.NODE_ENV === "production"
              ? "Something went wrong"
              : err.message,
        });
      }
    });

    // Handle 404
    app.use((req, res) => {
      if (
        req.path.includes("english-") ||
        req.headers["user-agent"]?.includes("Twilio")
      ) {
        const twiml = new VoiceResponse();

        twiml.say(
          { voice: "alice", language: "en-US" },
          "I'm sorry, but this endpoint does not exist."
        );
        twiml.hangup();

        res.type("text/xml");
        res.send(twiml.toString());
      } else {
        res.status(404).json({ error: "Not Found" });
      }
    });

    // Start the server
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to connect to database:", err);
    process.exit(1);
  });
