const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Machine, LineDecoder, validFrame } = require('./model.js');

function frame(overrides = {}) {
  return { v: 1, boot: 99, seq: 1, ms: 100, motor: 0, inputs: 112, pulses: 0,
    detected: [0, 0, 0, 0], diverted: [0, 0, 0], dropped: 0, event: 'state',
    belt: [0, 0, 0, 0, 0, 0, 0], step: 1, step_ms: 1000, phase_ms: 0, ...overrides };
}
test('serial parser handles fragmented lines, boot logs, invalid JSON and recovery', () => {
  const received = [], parser = new LineDecoder(f => received.push(f));
  const line = '@XC241 ' + JSON.stringify(frame()) + '\r\n';
  parser.push('ESP boot log\n' + line.slice(0, 30));
  assert.equal(received.length, 0);
  parser.push(line.slice(30) + '@XC241 nope\n@XC241 {}\n');
  assert.equal(received.length, 1); assert.equal(parser.invalid, 2);
  parser.push('x'.repeat(9000)); assert.equal(parser.pending.length, 0);
  parser.push(line); assert.equal(received.length, 2);
  assert.equal(validFrame(frame({ pulses: 16 })), false);
});
test('recognition follows firmware memory, not a raw medium sensor pulse', () => {
  const m = new Machine(); m.accept(frame({ inputs: 114, detected: [0, 1, 0, 0] }));
  assert.equal(m.pieces.length, 0);
  m.accept(frame({ seq: 2, step: 2, inputs: 113, belt: [2, 0, 0, 0, 0, 0, 0] }));
  assert.equal(m.pieces.length, 1); assert.equal(m.pieces[0].size, 1);
});
test('pieces and belt move only during motor on, stop at firmware slots, keep identity', () => {
  const m = new Machine(); m.accept(frame({ belt: [1, 0, 0, 0, 0, 0, 0] }));
  const id = m.pieces[0].id, x = m.pieces[0].x;
  m.advance(0.5); assert.equal(m.pieces[0].x, x); assert.equal(m.belt, 0);
  m.accept(frame({ seq: 2, motor: 1, belt: [1, 0, 0, 0, 0, 0, 0] }));
  m.advance(0.5); assert(m.pieces[0].x > x);
  m.accept(frame({ seq: 3, step: 2, belt: [0, 1, 0, 0, 0, 0, 0] }));
  assert.equal(m.pieces[0].id, id); assert.equal(m.pieces[0].slot, 1);
  const stopped = m.pieces[0].x; m.advance(0.5); assert.equal(m.pieces[0].x, stopped);
});
test('simultaneous cylinder packets do not duplicate pieces; pieces fall and disappear', () => {
  const m = new Machine(), belt = [0, 0, 1, 0, 2, 0, 0];
  m.accept(frame({ belt }));
  m.accept(frame({ seq: 2, belt, pulses: 1, diverted: [1, 0, 0] }));
  m.accept(frame({ seq: 3, belt, pulses: 3, diverted: [1, 1, 0] }));
  assert.equal(m.pieces.length, 2); assert(m.pieces.every(p => p.fall === 0));
  m.accept(frame({ seq: 4, pulses: 3, diverted: [1, 1, 0] }));
  m.advance(0.81); assert.equal(m.pieces.length, 0); assert.equal(m.delivered, 2);
});
test('reconnection reconstructs seven slots without replaying historical actuator counts', () => {
  const m = new Machine();
  m.accept(frame({ belt: [2, 0, 0, 0, 0, 0, 0], diverted: [41, 32, 20] }));
  assert.equal(m.pieces.length, 1); assert.equal(m.delivered, 0);
  m.accept(frame({ seq: 8, step: 5, belt: [0, 0, 0, 0, 2, 0, 0], diverted: [41, 32, 20] }));
  assert.equal(m.pieces.length, 1); assert.equal(m.pieces[0].slot, 4); assert.equal(m.missed, 6);
  m.accept(frame({ boot: 100, belt: [1, 0, 0, 0, 0, 0, 0] }));
  assert.equal(m.missed, 0); assert.equal(m.pieces.length, 1); assert.equal(m.delivered, 0);
});
test('lost actuator packet recovers removal from firmware memory without phantom pieces', () => {
  const m = new Machine(); m.accept(frame({ belt: [0, 0, 1, 0, 0, 0, 0] }));
  m.accept(frame({ seq: 4, diverted: [1, 0, 0] }));
  assert.equal(m.pieces.length, 1); assert.equal(m.pieces[0].fall, 0);
  m.advance(1); assert.equal(m.delivered, 1);
  m.accept(frame({ seq: 5, diverted: [1, 0, 0] })); assert.equal(m.pieces.length, 0);
});
test('an isolated actuator event never invents a workpiece', () => {
  const m = new Machine(); m.accept(frame());
  m.accept(frame({ seq: 2, diverted: [1, 1, 1], pulses: 7 }));
  m.advance(1); assert.equal(m.pieces.length, 0); assert.equal(m.delivered, 0);
});
