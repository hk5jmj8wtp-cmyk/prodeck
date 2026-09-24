# Ask ProDeck with Gemini

On the Mac running ProDeck, open **Settings → Troubleshooter — Ask ProDeck**. Choose **Gemini (Google)** under **AI provider**, paste your Gemini API key, and press **Save**. Get a key from [Google AI Studio](https://aistudio.google.com/apikey).

The default model is `gemini-3.8-flash`. The model field also accepts another model ID available to your key. Google documents the default model and supported function calling at [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash).

Ask ProDeck continues to use the routing map, live state, knowledge files, read-only tools, and citations. Requests go through the booth Mac for both desktop and crew browsers. Gemini's key is hidden from browser clients and entered on the Mac. This uses ProDeck's existing Gemini API key setting, which is shared with other Gemini features. Provider switching remembers Claude and Gemini models independently and keeps both keys.

The monthly Ask ProDeck call cap and crew-access switch apply to either provider. A question can use several calls as it looks up information. Gemini uses low thinking on Gemini 3 models and a bounded response budget with room for reasoning. Model metadata and [thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures) are preserved between tool calls.

Existing installations continue to select Claude until changed. Auto-Follow's Claude configuration remains separate from the Ask ProDeck provider selection.

Validation covers provider switching, old settings, the Gemini request/response format, parallel tools, preserved signatures, error handling, and the existing frontend tool loop. A local HTTP simulator also checks the Google authentication header and a complete tool-call/result/answer exchange. Live Google authentication and account quota must be verified using a real API key.
