# FallBridge

**Web Bluetooth GATT terminal for BLE-mesh dongles.** Your browser is the UI. The dongle is the radio.

Live: **https://sjgant80-hub.github.io/fallbridge/**

## What it does

Browsers can't advertise BLE. They can't be a peripheral. They can't join a mesh by themselves. But they CAN talk to a GATT peripheral over Web Bluetooth — so FallBridge pairs your Chrome or Edge tab to a small hardware dongle that DOES do the mesh, and gives you a clean UI on top.

- Pair with any BLE-UART (Nordic UART Service) device, OR any Meshtastic device
- Send and receive mesh messages from the browser
- See peers your dongle has heard from, with RSSI and hop count
- Raw hex terminal for firmware development
- Register as a FallCarrier transport so FallMail and other estate apps route over the mesh when it's available

## Which hardware to buy

Any BLE + LoRa combo running Meshtastic. TBA–TBA.

| Dongle | Chip | Best for | Guide |
|---|---|---|---|
| LILYGO T-Beam v1.2 | ESP32 + SX1276 + GPS | The workhorse. Range, battery, GPS. | [meshtastic.org · T-Beam](https://meshtastic.org/docs/hardware/devices/lilygo/tbeam/) |
| LILYGO T-Echo | nRF52 + e-paper + LoRa | Handheld carry. Sunlight readable. | [meshtastic.org · T-Echo](https://meshtastic.org/docs/hardware/devices/lilygo/techo/) |
| Heltec V3 LoRa32 | ESP32-S3 + OLED + LoRa | Cheapest ticket in. Desktop base. | [meshtastic.org · Heltec V3](https://meshtastic.org/docs/hardware/devices/heltec-automation/lora32/) |
| RAK4631 (WisBlock) | nRF52840 + LoRa | Best power efficiency. Solar nodes. | [meshtastic.org · WisBlock](https://meshtastic.org/docs/hardware/devices/rak/wisblock/) |

Flash the firmware in Chrome: **https://flasher.meshtastic.org/** — plug USB in, pick board, click flash. Two minutes.

## Browser support

Web Bluetooth is only available on:

- Chrome (desktop)
- Edge (desktop)
- Chrome on Android

**iOS Safari does not support Web Bluetooth.** Nothing anyone can do about that — Apple's policy.

The page must be served over HTTPS (or `localhost`). Both requirements are met on the GitHub Pages URL above.

## Using the library

```js
import { FallBridge } from 'https://sjgant80-hub.github.io/fallbridge/fallbridge.js';

const bridge = new FallBridge();
await bridge.pair();            // shows Web Bluetooth chooser

bridge.onMessage(m => console.log(m.from, m.text));
bridge.onPeer(p => console.log('peer:', p.id));

await bridge.send('hello mesh');            // broadcast
await bridge.send('hi you', '!7a3c9b12');   // to a specific node

// FallCarrier integration
window.FallCarrier?.register(bridge.asCarrierTransport());
```

## Protocol support

FallBridge auto-detects on pair:

- **Meshtastic** — primary service `6ba1b218-15a8-461f-9fa8-5dcae273eafd`. Full protobuf parsing is out of scope for the shim; the library surfaces frames as messages and sniffs printable text. Companion firmware can accept the simplified JSON envelope.
- **Nordic UART Service (NUS)** — service `6e400001-b5a3-f393-e0a9-e50e24dcca9e`. Works with any BLE-UART firmware. Expected line-framed protocol from the dongle:
  - `<FROM|hops|rssi|text` — incoming mesh message
  - `%PEER|id|name|rssi|hops` — peer advertisement
  - `%ACK|id` — delivery ack
  - anything else — raw fallback

## Estate primitives

FallBridge is one node in the AI-Native Solutions sovereign SMB estate.

- **FallID** — https://sjgant80-hub.github.io/fallid/ · peer identity
- **FallCarrier** — https://sjgant80-hub.github.io/fallcarrier/ · transport orchestrator
- **FallMail** — https://sjgant80-hub.github.io/fallmail/ · uses FallBridge when available

## License

MIT. Fork, run, mesh.
