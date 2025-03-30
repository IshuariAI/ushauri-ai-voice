const VoiceResponse = require("twilio").twiml.VoiceResponse;
const axios = require("axios");

const conversations = {};
const pendingRequests = {};

function setupEnglishBot(app) {
  app.post("/english-voice", async (req, res) => {
    console.log("\n==========================\n");
    console.log("# NEW CALL STARTED");
    console.log("\n==========================\n");

    const twiml = new VoiceResponse();
    const callSid = req.body.CallSid;

    console.log(`# New English call received: ${callSid}`);

    conversations[callSid] = {
      messages: [],
      lastUpdated: Date.now(),
      counter: 0,
    };

    twiml.say(
      {
        voice: "alice",
        language: "en-US",
      },
      "Welcome to the Ushauri Legal Assistant. How may I help you today?"
    );

    twiml.record({
      action: "/english-wait-for-transcription",
      maxLength: 60,
      timeout: 2,
      transcribe: true,
      transcribeCallback: "/english-transcription",
      playBeep: true,
    });

    console.log(`# Active conversations: ${Object.keys(conversations).length}`);
    console.log(`# Pending requests: ${Object.keys(pendingRequests).length}`);

    res.type("text/xml");
    res.send(twiml.toString());
  });

  app.post("english-transcription", async (req, res) => {
    res.sendStatus(200);
    const callSid = req.body.CallSid;
    const transcriptionStatus = req.body.TranscriptionStatus;
    const transcriptionText = req.body.TranscriptionText;

    console.log("\n==========================\n");
    console.log("# TRANSCRIPTION RECEIVED");
    console.log("\n==========================\n");
    console.log(`# Transcription for call ${callSid}: ${transcriptionStatus}`);

    console.log(`# All transcription data:`);
    console.log(req.body, null, 2);

    if (transcriptionStatus === "completed" && transcriptionText) {
      console.log(`# TRANSCRIBED TEXT: ${transcriptionText}`);

      if (pendingRequests[callSid]) {
        console.log(
          `# Found pending request for call ${callSid}, processing with trascription`
        );

        const turnNumber = pendingRequests[callSid].turnNumber;

        conversations[callSid].lastUpdated = Date.now();
        conversations[callSid].messages.push({
          role: "user",
          content: transcriptionText,
        });

        console.log(`# Calling AI service for response - Turn ${turnNumber}`);
        let aiResponse;

        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => {
            controller.abort();
          }, 7000);

          const response = await axios.post(
            process.env.RENDER_ENDPOINT,
            {
              text: transcriptionText,
              conversations: conversations[callSid].messages.slice(-4),
            },
            { signal: controller.signal }
          );
          clearTimeout(timeoutId);

          if (response.data && response.data.answer) {
            aiResponse = response.data.answer;
          } else {
            console.warn("# No answer found in AI response");
            aiResponse = "Sorry, I didn't get that. Can you repeat?";
          }
        } catch (error) {
          console.error("# Error calling AI service:", error);
          aiResponse = "Sorry, I didn't get that. Can you repeat?";
        }
        console.log(`# AI response: ${aiResponse.substring(0, 100)}...`);

        conversations[callSid].messages.push({
          role: "assistant",
          content: aiResponse,
        });

        pendingRequests[callSid].aiResponse = aiResponse;
        pendingRequests[callSid].ready = true;
        pendingRequests[callSid].processedAt = Date.now();
        console.log(`# Response for call ${callSid}`);

        console.log("\n Current pending requests status:");
        for (const sid in pendingRequests) {
          console.log(
            `${sid}: ready=${pendingRequests[sid].ready}, failed=${pendingRequests[sid].failed}`
          );
        }
      } else {
        console.log(
          `# No pending request for call ${callSid}, storing transcription`
        );

        pendingRequests[callSid] = {
          turnNumber: conversations[callSid]
            ? conversations[callSid].counter + 1
            : 1,
          transcriptionText,
          ready: false,
          createdAt: Date.now(),
        };
      }
    } else if (transcriptionStatus === "failed") {
      console.log(`# Transcription failed for call ${callSid}`);

      if (pendingRequests[callSid]) {
        pendingRequests[callSid].failed = true;
        pendingRequests[callSid].failedAt = Date.now();
        console.log(`# Marking pending request for call ${callSid} as failed`);
      }
    } else {
      console.log(
        `# Non-complete transcription status for call ${callSid}: ${transcriptionStatus}`
      );
    }
  });

  app.post("/english-wait-for-transcription", (req, res) => {
    console.log("\n==========================\n");
    console.log("# WAIT FOR TRANSCRIPTION");
    console.log("\n==========================\n");
    const twiml = new VoiceResponse();
    const callSid = req.body.CallSid;

    try {
      if (!conversations[callSid]) {
        conversations[callSid] = {
          messages: [],
          lastUpdated: Date.now(),
          counter: 0,
        };
      }

      conversations[callSid].counter++;
      const turnNumber = conversations[callSid].counter;
      console.log(
        `# Turn number: ${turnNumber}, Waiting for transcription for call ${callSid}`
      );

      pendingRequests[callSid] = {
        turnNumber,
        ready: false,
        createdAt: Date.now(),
      };

      console.log(`# Created pending request for call ${callSid}`);

      twiml.say(
        {
          voice: "alice",
          language: "en-US",
        },
        `/english-check-transcription?poll=1&maxPolls=40`
      );
      res.type("text/xml");
      res.send(twiml.toString());
    } catch (error) {
      console.error(
        `# Error processing transcription for call ${callSid}: ${error.message}`
      );
      console.error(error.stack);

      twiml.say(
        {
          voice: "alice",
          language: "en-US",
        },
        "I apologize for the technical issue. Please repeat your question after the beep"
      );

      twiml.record({
        action: "/english-wait-for-transcription",
        maxLength: 60,
        timeout: 2,
        transcribe: true,
        transcribeCallback: "/english-transcription",
        maxSilence: 5,
        playBeep: true,
      });
      res.type("text/xml");
      res.send(twiml.toString());
    }
  });

  app.post(
    "/english-check-transcription",
    (req, res) => {
      const twiml = new VoiceResponse();
      const callSid = req.body.CallSid;
      const currentPoll = req.body.poll || "1";
      const maxPolls = req.query.maxPolls || "40";

      console.log(`# Poll attempt ${currentPoll} for call ${callSid}`);

      try {
        if (
          pendingRequests[callSid] &&
          pendingRequests[callSid].ready &&
          pendingRequests[callSid].aiResponse
        ) {
          console.log(`# Response is ready for call ${callSid}`);
          const aiResponse = pendingRequests[callSid].aiResponse;
          speakLongResponse(twiml, aiResponse);
          delete pendingRequests[callSid];
          twiml.pause({ length: 1 });

          const prompts = [
            "Do you have a specific legal question? Please speak after the beep",
          ];

          const turnNumber = conversations[callSid]
            ? conversations[callSid].counter
            : 1;
          const promptIndex = (turnNumber - 1) % prompts.length;
          twiml.say(
            { voice: "alice", language: "en-US" },
            prompts[promptIndex]
          );
          twiml.record({
            action: "/english-wait-for-transcription",
            maxLength: 60,
            timeout: 2,
            transcribe: true,
            transcribeCallback: "/english-transcription",
            maxSilence: 5,
            playBeep: true,
          });
        } else if (
          pendingRequests[callSid] &&
          pendingRequests[callSid].failed
        ) {
          console.warn(`# Transcription failed for call ${callSid}`);

          twiml.say(
            {
              voice: "alice",
              language: "en-US",
            },
            "I apologize for the technical issue. Please repeat your question after the beep"
          );

          delete pendingRequests[callSid];
          twiml.record({
            action: "/english-wait-for-transcription",
            maxLength: 60,
            timeout: 2,
            transcribe: true,
            transcribeCallback: "/english-transcription",
            maxSilence: 5,
            playBeep: true,
          });
        } else if (currentPoll >= maxPolls) {
          console.warn(`# Max polls reached for call ${callSid}`);

          twiml.say(
            {
              voice: "alice",
              language: "en-US",
            },
            "I apologize for the technical issue. Please repeat your question after the beep"
          );
          delete pendingRequests[callSid];
          twiml.record({
            action: "/english-wait-for-transcription",
            maxLength: 60,
            timeout: 2,
            transcribe: true,
            transcribeCallback: "/english-transcription",
            maxSilence: 5,
            playBeep: true,
          });
        } else {
          twiml.pause({ length: 1 });

          if (currentPoll % 5 === 0) {
            twiml.say(
              {
                voice: "alice",
                language: "en-US",
              },
              "Still processing your question, continue to hold..."
            );
          }

          twiml.redirect(
            {
              method: "POST",
            },
            `/english-check-transcription?poll=${
              parseInt(currentPoll) + 1
            }&maxPolls=${maxPolls}`
          );
          res.type("text/xml");
          res.send(twiml.toString());
        }
      } catch (error) {
        console.error(
          `# Error processing transcription for call ${callSid}: ${error.message}`
        );
        console.error(error.stack);

        twiml.say(
          {
            voice: "alice",
            language: "en-US",
          },
          "I apologize for the technical issue. Please repeat your question after the beep"
        );

        delete pendingRequests[callSid];
        twiml.record({
          action: "/english-wait-for-transcription",
          maxLength: 60,
          timeout: 2,
          transcribe: true,
          transcribeCallback: "/english-transcription",
          maxSilence: 5,
          playBeep: true,
        });
      }

      app.get("/english-debug", (req, res) => {
        const state = {
          conversations: Object.keys(conversations).map((key) => ({
            callSid: key,
            turnCount: conversations[key].counter,
            lastUpdated: conversations[key].lastUpdated,
            messageCount: conversations[key].messages.length,
          })),
          pendingRequests: Object.keys(pendingRequests).map((key) => ({
            callSid: key,
            turnNumber: pendingRequests[key].turnNumber,
            ready: pendingRequests[key].ready,
            createdAt: pendingRequests[key].createdAt,
            failed: pendingRequests[key].failed,
          })),
        };
        res.json(state);
      });

      setInterval(() => {
        const now = Date.now();

        for (const callSid in pendingRequests) {
          if (now - pendingRequests.createdAt > 300000) {
            console.log(
              `# Deleting pending request for call ${callSid} due to timeout`
            );
            delete pendingRequests[callSid];
          }
        }

        for (const callSid in conversations) {
          if (now - conversations[callSid].lastUpdated > 300000) {
            console.log(
              `# Deleting conversation for call ${callSid} due to timeout`
            );
            delete conversations[callSid];
          }
        }
      }, [300000]);
      console.log(`# English bot setup complete`);
    },
    function speakLongResponse(twiml, response) {
      const MAX_CHUNK_LENGTH = 400;

      if (text.length <= MAX_CHUNK_LENGTH) {
        twiml.say({ voice: "alice", language: "en-US" }, response);
        return;
      }

      const sentences = response.match(/[^.!?]+[.!?]+/g) || [];
      let currentChunk = "";

      for (const sentence of sentences) {
        if (currentChunk.length + sentence.length <= MAX_CHUNK_LENGTH) {
          currentChunk += sentence;
        } else {
          twiml.say({ voice: "alice", language: "en-US" }, currentChunk);
          currentChunk = sentence;
        }
      }

      if (currentChunk) {
        twiml.say({ voice: "alice", language: "en-US" }, currentChunk.trim());
      }
    }
  );
}
module.exports = setupEnglishBot;
