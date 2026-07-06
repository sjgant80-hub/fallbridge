// FallBridge · Web Bluetooth GATT bridge for BLE-mesh dongles
// MIT · AI-Native Solutions · sjgant80-hub/fallbridge
// Browser is UI · dongle does mesh (Meshtastic / NUS UART)

const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';  // browser writes here
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';  // browser subscribes here

const MESH_SERVICE = '6ba1b218-15a8-461f-9fa8-5dcae273eafd';
const MESH_TORADIO   = 'f75c76d2-129e-4dad-a1dd-7866124401e7';
const MESH_FROMRADIO = '2c55e69e-4993-11ed-b878-0242ac120002';
const MESH_FROMNUM   = 'ed9da18c-a800-4f66-a670-aa7547e34453';

const BATTERY_SERVICE = 'battery_service';
const BATTERY_LEVEL   = 'battery_level';

const DEVINFO_SERVICE = 'device_information';
const FIRMWARE_CHAR   = 'firmware_revision_string';

export class FallBridge {
  constructor(opts = {}) {
    this.device = null;
    this.server = null;
    this.protocol = null;         // 'nus' | 'meshtastic' | null
    this.rxChar = null;           // char we WRITE to
    this.txChar = null;           // char we NOTIFY from
    this.batteryChar = null;
    this.peers = new Map();       // id -> { id, name, lastSeen, rssi, hops }
    this.messages = [];           // ring buffer
    this.listeners = { message: [], state: [], peer: [] };
    this.connected = false;
    this.debug = opts.debug || false;
    this.myId = opts.myId || null;
    this._rxBuffer = '';
  }

  on(event, fn) {
    if (this.listeners[event]) this.listeners[event].push(fn);
    return this;
  }
  onMessage(fn) { return this.on('message', fn); }
  onState(fn) { return this.on('state', fn); }
  onPeer(fn) { return this.on('peer', fn); }

  _emit(event, ...args) {
    (this.listeners[event] || []).forEach(fn => {
      try { fn(...args); } catch(e) { console.warn('[fallbridge] listener err', e); }
    });
  }

  async pair() {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth not supported. Use Chrome or Edge on desktop or Android.');
    }
    this._emit('state', { state: 'requesting' });
    const device = await navigator.bluetooth.requestDevice({
      filters: [
        { services: [NUS_SERVICE] },
        { services: [MESH_SERVICE] },
        { namePrefix: 'Meshtastic' },
        { namePrefix: 'T-Beam' },
        { namePrefix: 'T-Echo' },
        { namePrefix: 'Heltec' },
        { namePrefix: 'RAK' },
        { namePrefix: 'FallBridge' }
      ],
      optionalServices: [NUS_SERVICE, MESH_SERVICE, BATTERY_SERVICE, DEVINFO_SERVICE]
    });
    this.device = device;
    device.addEventListener('gattserverdisconnected', () => this._onDisconnected());
    this._emit('state', { state: 'connecting', name: device.name });
    const server = await device.gatt.connect();
    this.server = server;

    // detect protocol — try Meshtastic first, fall back to NUS
    try {
      const svc = await server.getPrimaryService(MESH_SERVICE);
      const toradio = await svc.getCharacteristic(MESH_TORADIO);
      const fromradio = await svc.getCharacteristic(MESH_FROMRADIO);
      let fromnum;
      try { fromnum = await svc.getCharacteristic(MESH_FROMNUM); } catch(e) {}
      this.protocol = 'meshtastic';
      this.rxChar = toradio;
      this.txChar = fromradio;
      this._fromnumChar = fromnum;
      if (fromnum) {
        await fromnum.startNotifications();
        fromnum.addEventListener('characteristicvaluechanged', () => this._drainMeshtastic());
      }
    } catch(e) {
      const svc = await server.getPrimaryService(NUS_SERVICE);
      this.rxChar = await svc.getCharacteristic(NUS_RX);
      this.txChar = await svc.getCharacteristic(NUS_TX);
      this.protocol = 'nus';
      await this.txChar.startNotifications();
      this.txChar.addEventListener('characteristicvaluechanged', (ev) => this._onNusData(ev));
    }

    // optional battery
    try {
      const bs = await server.getPrimaryService(BATTERY_SERVICE);
      this.batteryChar = await bs.getCharacteristic(BATTERY_LEVEL);
    } catch(e) {}

    this.connected = true;
    this._emit('state', {
      state: 'connected',
      name: device.name,
      protocol: this.protocol
    });

    if (this.protocol === 'meshtastic') {
      // initial drain
      this._drainMeshtastic();
    }
    return { name: device.name, protocol: this.protocol };
  }

  async getBattery() {
    if (!this.batteryChar) return null;
    try {
      const v = await this.batteryChar.readValue();
      return v.getUint8(0);
    } catch(e) { return null; }
  }

  async send(msg, destination) {
    if (!this.connected || !this.rxChar) throw new Error('not connected');
    if (this.protocol === 'nus') {
      const payload = destination
        ? `>${destination}|${msg}\n`
        : `>ALL|${msg}\n`;
      const bytes = new TextEncoder().encode(payload);
      // chunk to 20 byte MTU
      for (let i = 0; i < bytes.length; i += 20) {
        await this.rxChar.writeValueWithoutResponse(bytes.slice(i, i + 20));
      }
      const rec = { dir: 'out', text: msg, dest: destination || 'ALL', ts: Date.now() };
      this.messages.push(rec);
      this._emit('message', rec);
      return rec;
    }
    if (this.protocol === 'meshtastic') {
      // wrap in a minimal proto-lite envelope · the dongle firmware handles routing
      const env = new TextEncoder().encode(JSON.stringify({
        to: destination || '^all',
        text: msg,
        ts: Date.now()
      }));
      // real Meshtastic protobuf ToRadio has type + payload · this simplified frame
      // will be interpreted by companion firmware; for full spec see meshtastic/protobufs
      const framed = new Uint8Array(env.length + 2);
      framed[0] = 0x94; framed[1] = env.length & 0xff;
      framed.set(env, 2);
      for (let i = 0; i < framed.length; i += 20) {
        await this.rxChar.writeValueWithoutResponse(framed.slice(i, i + 20));
      }
      const rec = { dir: 'out', text: msg, dest: destination || '^all', ts: Date.now() };
      this.messages.push(rec);
      this._emit('message', rec);
      return rec;
    }
  }

  async sendHex(hex) {
    if (!this.connected || !this.rxChar) throw new Error('not connected');
    const clean = hex.replace(/[^0-9a-fA-F]/g, '');
    if (clean.length % 2) throw new Error('odd hex length');
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i*2, 2), 16);
    for (let i = 0; i < bytes.length; i += 20) {
      await this.rxChar.writeValueWithoutResponse(bytes.slice(i, i + 20));
    }
    return bytes.length;
  }

  _onNusData(ev) {
    const val = ev.target.value;
    const text = new TextDecoder().decode(val);
    this._rxBuffer += text;
    let idx;
    while ((idx = this._rxBuffer.indexOf('\n')) >= 0) {
      const line = this._rxBuffer.slice(0, idx).replace(/\r$/, '');
      this._rxBuffer = this._rxBuffer.slice(idx + 1);
      if (line) this._parseNusLine(line);
    }
  }

  _parseNusLine(line) {
    // Expected patterns from companion firmware:
    //   <FROM|hops|rssi|text        (incoming msg)
    //   %PEER|id|name|rssi          (peer advertisement)
    //   %ACK|id                     (delivery ack)
    //   plain text = raw fallback
    if (line.startsWith('<')) {
      const parts = line.slice(1).split('|');
      const rec = {
        dir: 'in',
        from: parts[0] || '?',
        hops: parseInt(parts[1] || '0'),
        rssi: parseInt(parts[2] || '0'),
        text: parts.slice(3).join('|'),
        ts: Date.now()
      };
      this.messages.push(rec);
      this._touchPeer(rec.from, rec.rssi);
      this._emit('message', rec);
      return;
    }
    if (line.startsWith('%PEER|')) {
      const parts = line.slice(6).split('|');
      const p = {
        id: parts[0],
        name: parts[1] || parts[0],
        rssi: parseInt(parts[2] || '0'),
        hops: parseInt(parts[3] || '0'),
        lastSeen: Date.now()
      };
      this.peers.set(p.id, p);
      this._emit('peer', p);
      return;
    }
    if (line.startsWith('%')) {
      // control message · pass through as system record
      const rec = { dir: 'sys', text: line, ts: Date.now() };
      this.messages.push(rec);
      this._emit('message', rec);
      return;
    }
    const rec = { dir: 'in', from: '?', hops: 0, rssi: 0, text: line, ts: Date.now() };
    this.messages.push(rec);
    this._emit('message', rec);
  }

  async _drainMeshtastic() {
    if (!this.txChar) return;
    try {
      // Meshtastic FromRadio is read-until-empty
      for (let i = 0; i < 32; i++) {
        const v = await this.txChar.readValue();
        if (!v || v.byteLength === 0) break;
        this._parseMeshtasticFrame(new Uint8Array(v.buffer));
      }
    } catch(e) {
      if (this.debug) console.warn('[fallbridge] drain err', e);
    }
  }

  _parseMeshtasticFrame(bytes) {
    // Full Meshtastic protobuf is out of scope for the shim; we surface as sys record
    // and try to sniff any printable text run.
    const printable = [];
    for (const b of bytes) if (b >= 0x20 && b < 0x7f) printable.push(String.fromCharCode(b));
    const guess = printable.join('').replace(/\s+/g, ' ').trim();
    // heuristic peer sniff — Meshtastic node id is typically !xxxxxxxx
    const idMatch = guess.match(/![0-9a-f]{8}/);
    if (idMatch) this._touchPeer(idMatch[0], 0);
    const rec = {
      dir: 'in',
      from: idMatch ? idMatch[0] : 'mesh',
      hops: 0, rssi: 0,
      text: guess || `[${bytes.length}B frame]`,
      ts: Date.now(),
      raw: Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('')
    };
    this.messages.push(rec);
    this._emit('message', rec);
  }

  _touchPeer(id, rssi) {
    const now = Date.now();
    const existing = this.peers.get(id);
    const p = existing
      ? { ...existing, rssi: rssi || existing.rssi, lastSeen: now }
      : { id, name: id, rssi, hops: 0, lastSeen: now };
    this.peers.set(id, p);
    this._emit('peer', p);
  }

  getPeers() {
    const cutoff = Date.now() - 5 * 60 * 1000;
    return Array.from(this.peers.values())
      .filter(p => p.lastSeen > cutoff)
      .sort((a,b) => b.lastSeen - a.lastSeen);
  }

  getMessages(limit = 100) {
    return this.messages.slice(-limit);
  }

  _onDisconnected() {
    this.connected = false;
    this._emit('state', { state: 'disconnected' });
  }

  disconnect() {
    if (this.device && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
    this.connected = false;
  }

  // FallCarrier transport contract
  asCarrierTransport() {
    const self = this;
    return {
      name: 'fallbridge-ble-mesh',
      available: () => self.connected,
      send: async (envelope) => {
        const payload = typeof envelope === 'string' ? envelope : JSON.stringify(envelope);
        return self.send(payload, envelope && envelope.to);
      },
      subscribe: (fn) => {
        self.on('message', (rec) => {
          if (rec.dir === 'in') fn(rec);
        });
      },
      peers: () => self.getPeers()
    };
  }
}

export default FallBridge;
