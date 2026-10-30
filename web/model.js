/* Shared by the browser and Node's tests. No hardware commands live here. */
(function (root) {
  "use strict";
  const INPUTS = ["sp", "sm", "sg", "Smet", "fBp", "fBm", "fBg"];
  const SIZES = ["Pequena", "Média", "Grande"];
  const STATIONS = [0.36, 0.627, 0.893];
  const SLOT_X = [0.14, 0.25, 0.36, 0.4935, 0.627, 0.76, 0.893, 1];
  const uint32 = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
  function validFrame(f) {
    return f && f.v === 1 && uint32(f.boot) && uint32(f.seq) && uint32(f.ms) &&
      (f.motor === 0 || f.motor === 1) && Number.isInteger(f.inputs) && f.inputs >= 0 && f.inputs <= 255 &&
      Number.isInteger(f.pulses) && f.pulses >= 0 && f.pulses <= 15 && uint32(f.dropped) &&
      Array.isArray(f.detected) && f.detected.length === 4 && f.detected.every(uint32) &&
      Array.isArray(f.diverted) && f.diverted.length === 3 && f.diverted.every(uint32) &&
      typeof f.event === "string" && f.event.length <= 24 &&
      Array.isArray(f.belt) && f.belt.length === 7 && f.belt.every(value => Number.isInteger(value) && value >= 0 && value <= 3) &&
      uint32(f.step) && uint32(f.step_ms) && uint32(f.phase_ms);
  }
  class LineDecoder {
    constructor(accept) { this.accept = accept; this.pending = ""; this.invalid = 0; }
    push(chunk) {
      this.pending += chunk;
      let end;
      while ((end = this.pending.indexOf("\n")) >= 0) {
        const line = this.pending.slice(0, end);
        this.pending = this.pending.slice(end + 1);
        const prefix = line.lastIndexOf("@XC241 ");
        if (prefix < 0) continue;
        try {
          const f = JSON.parse(line.slice(prefix + 7).trim());
          if (!validFrame(f)) { this.invalid++; continue; }
          this.accept(f);
        } catch { this.invalid++; }
      }
      if (this.pending.length > 8192) { this.pending = ""; this.invalid++; }
    }
  }
  class Machine {
    constructor() { this.reset(); }
    reset() {
      this.frame = null; this.motor = false; this.inputs = 0; this.pulses = 0;
      this.pieces = []; this.nextId = 1; this.delivered = 0; this.belt = 0;
      this.messages = []; this.missed = 0;
      this.lastRecognition = "Aguardando reconhecimento";
      this.phase = 0;
    }
    log(code, text) { this.messages.push({ code, text }); }
    spawn(ms) {
      const piece = { id: this.nextId++, size: 0, metal: false, x: 0.14, ms, fall: null };
      this.pieces.push(piece);
      return piece;
    }
    divert(index) {
      const moving = this.pieces.filter(p => p.fall === null);
      const candidates = moving.filter(p => p.slot === (index + 1) * 2 && p.size === index);
      const p = candidates[0];
      this.log(["iBp", "iBm", "iBg"][index], `Cilindro de peças ${SIZES[index].toLowerCase()}s acionado`);
      if (!p) return; // Never fabricate a workpiece for an actuator-only event.
      p.x = STATIONS[index]; // Physical event anchors the estimated position.
      p.fall = 0;
    }
    syncBelt(f, fresh) {
      const steps = fresh ? 0 : (f.step - this.frame.step) >>> 0;
      if (steps > 1) {
        // Reconstruct from authoritative memory instead of inventing missed paths.
        this.pieces = this.pieces.filter(p => p.fall !== null);
        this.log("SYNC", "Memória da esteira ressincronizada após passos não recebidos");
      } else if (steps === 1) {
        for (const p of this.pieces) if (p.fall === null) { p.slot++; p.x = SLOT_X[Math.min(7, p.slot)]; }
      }
      for (let slot = 0; slot < 7; slot++) {
        const type = f.belt[slot];
        let p = this.pieces.find(p => p.fall === null && p.slot === slot);
        if (type && !p && (fresh || steps > 0 || this.frame.belt[slot] !== type)) {
          p = this.spawn(f.ms); p.slot = slot; p.x = SLOT_X[slot];
          p.size = type - 1; // Firmware stores size only; metal stays a separate input.
          this.lastRecognition = `#${p.id} · ${SIZES[p.size].toLowerCase()}${p.metal ? " · metal detectado" : ""}`;
          this.log(fresh ? "SYNC" : "PEÇA", `${fresh ? "Peça presente" : "Reconhecimento"}: ${this.lastRecognition}`);
        }
        if (p && type) p.size = type - 1;
        // A removed slot without a received actuator packet is still a removal
        // from firmware memory, not evidence of a confirmed physical arrival.
        if (p && !type) {
          if ([2, 4, 6].includes(slot)) { p.x = SLOT_X[slot]; p.fall = 0; }
          else { this.pieces = this.pieces.filter(other => other !== p); this.log("SYNC", `Peça #${p.id} removida da memória recebida`); }
        }
      }
      for (const p of this.pieces) if (p.fall === null && p.slot > 6) { p.x = 1; p.fall = 0; }
    }
    accept(f) {
      if (!validFrame(f)) return false;
      if (this.frame && f.boot === this.frame.boot && f.seq <= this.frame.seq) return false;
      const fresh = !this.frame || f.boot !== this.frame.boot;
      if (fresh) {
        const restarted = !!this.frame;
        this.reset();
        this.log(restarted ? "RESET" : "USB", restarted ? "ESP reiniciado; acompanhamento reiniciado" : "Telemetria recebida; sessão iniciada");
      } else {
        this.missed += Math.max(0, f.seq - this.frame.seq - 1);
      }
      this.syncBelt(f, fresh);
      if (!fresh) {
        for (let i = 0; i < 3; i++) {
          const count = (f.diverted[i] - this.frame.diverted[i]) >>> 0;
          for (let n = 0; n < Math.min(count, 8); n++) this.divert(i);
        }
        if (f.motor !== this.frame.motor) this.log(f.motor ? "ie" : "fe", f.motor ? "Motor da esteira ligado" : "Motor da esteira desligado");
        const raised = f.inputs & ~this.frame.inputs;
        for (let i = 0; i < 7; i++) if (raised & (1 << i)) this.log(INPUTS[i], i < 4 ? "Sensor ativo" : "Cilindro em repouso");
      }
      this.frame = f; this.motor = !!f.motor; this.inputs = f.inputs; this.pulses = f.pulses;
      this.phase = f.phase_ms / 1000;
      this.updatePositions();
      return true;
    }
    advance(seconds) {
      if (!(seconds > 0) || !Number.isFinite(seconds)) return;
      if (this.motor) this.belt = (this.belt + seconds * 80) % 28;
      this.phase += seconds;
      for (const p of this.pieces) {
        if (p.fall !== null) p.fall += seconds;
      }
      this.updatePositions();
      this.pieces = this.pieces.filter(p => {
        if (p.fall !== null && p.fall >= 0.8) {
          this.delivered++; this.log("BUFFER", `Peça #${p.id} enviada ao buffer (estimado)`); return false;
        }
        return true;
      });
    }
    updatePositions() {
      const progress = this.motor && this.frame && this.frame.step_ms ? Math.min(1, this.phase / (this.frame.step_ms / 1000)) : 0;
      for (const p of this.pieces) if (p.fall === null) p.x = SLOT_X[p.slot] + progress * (SLOT_X[p.slot + 1] - SLOT_X[p.slot]);
    }
  }
  const api = { Machine, LineDecoder, validFrame, INPUTS, SIZES };
  root.XC241 = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
