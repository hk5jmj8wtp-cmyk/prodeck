# propresenter 2

ProDeck can connect to two ProPresenter computers at the same time. The second connection is labeled **propresenter 2** in the sidebar and Settings.

## Connect the second computer

1. On the second computer, open ProPresenter's Network preferences and enable its network API. Note its address and port (usually 1025).
2. On the Mac running ProDeck, open **propresenter 2**. Use **Find ProPresenter on this network** to select that computer, or **Enter address manually** to enter its address and port.
3. Click **Connect**. A successful connection is saved for the next launch. You can also edit its address, port, and auto-connect option under **Settings → propresenter 2**.

The second page has its own playlists, slide previews, previous/next controls, looks, macros, props, messages, timers, and stage messages. The Clear toolbar targets machine two when this page is open and displays its name. On other pages it continues to target the first machine.

Disconnecting or reconnecting either connection leaves the other running. Machine two retries its saved address if the connection drops. When a second machine is configured, the first also stays on its saved address instead of automatically adopting an arbitrary computer found on the network. Stable hostnames or reserved IP addresses are recommended for both.

Existing dashboard widgets, Planning Center linking, Auto-Follow, TapLink, lobby automation, and MIDI/OSC inputs continue to use the first ProPresenter. They are not duplicated onto machine two. The second page is also available through ProDeck's browser gateway with the same access permissions as the first; establishing a connection is done on the Mac running ProDeck.

Validation uses two simulated API servers and frontend/browser checks. Testing against your two actual ProPresenter computers is still needed.
