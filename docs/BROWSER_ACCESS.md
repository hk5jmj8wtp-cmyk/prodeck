# Browser access

Keep ProDeck open on the Mac that hosts the gateway. In **Settings → Browser Access**, enable access, set an admin password, and press **Save**. Use one of the addresses shown under **Open in a browser** from another device on the same network. The loopback address is for the host Mac only.

The network addresses come from the operating system, not the editable device name. On macOS, ProDeck shows the current network IP and Bonjour hostname. An IP may change when the Mac changes networks; check this screen for its current address. Crew and kiosk links use the configured Public URL when present, otherwise the detected LAN address. Regenerate old QR codes or bookmarks that contain an incorrect address.

The gateway's status reports a successfully bound listener. Saving settings on the same port keeps it running; Restart waits for the old listener to release the port. If a new port is already occupied, ProDeck reports the error and retains the previous working listener. The displayed serving address continues to show its actual port.

Regression checks cover repeated saves/restarts, changing ports, occupied ports, URL generation, and public-URL overrides. The packaged Mac app was also checked through its Settings UI: correct addresses, Restart, Save, and the live browser sign-in page.
