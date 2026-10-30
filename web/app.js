"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const { Machine, LineDecoder, INPUTS } = XC241;
  const machine = new Machine();
  const sensorNames = ["Pequena · nível", "Média · nível¹", "Grande · inativo", "Metal", "Retorno P", "Retorno M", "Retorno G"];
  let port = null, reader = null, reading = null, connecting = false, closing = false;
  let lastPacket = 0, lastAnimation = performance.now(), demo = null, logEmpty = true;
  let parser = new LineDecoder(receive);
  INPUTS.forEach((name, index) => {
    const node = document.createElement("div"); node.className = "sensor"; node.id = `sensor-${index}`;
    node.innerHTML = `<i></i><b>${name}</b><span class="sensor-level">—</span><p class="sensor-name">${sensorNames[index]}</p>`;
    $("sensors").append(node);
  });
  const returnOutput = document.createElement("div"); returnOutput.className = "sensor"; returnOutput.id = "sensor-7";
  returnOutput.innerHTML = '<i></i><b>iBgV</b><span class="sensor-level">—</span><p class="sensor-name">Saída retorno G</p>';
  $("sensors").append(returnOutput);
  function notice(message, warning = false) {
    $("notice").textContent = message; $("notice").classList.toggle("warning", warning);
  }
  function receive(f) {
    if (!machine.accept(f)) return;
    lastPacket = performance.now();
    if (demo) notice("DEMONSTRAÇÃO · Dados ilustrativos gerados nesta página. Nenhuma conexão com a máquina.", true);
    else if (f.dropped || machine.missed) notice("Telemetria com perdas de pacotes. Estados foram atualizados; o trajeto de algumas peças pode estar incompleto.", true);
    else notice("Recebendo estados do ESP por USB. Motor, sensores e cilindros ao vivo; posição e chegada ao buffer estimadas.");
  }
  async function readPort(selected) {
    const decoder = new TextDecoder();
    try {
      reader = selected.readable.getReader();
      while (!closing) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      if (!closing) notice(`Leitura interrompida: ${error.message}. Reconecte a placa.`, true);
    } finally {
      if (reader) { reader.releaseLock(); reader = null; }
      try { await selected.close(); } catch { /* Unplugged ports may already be closed. */ }
      if (port === selected) port = null;
      closing = false;
      machine.motor = false; lastPacket = 0;
      if (!$("notice").classList.contains("warning")) notice("Porta desconectada. A visualização foi congelada.");
      refresh();
    }
  }
  async function disconnect() {
    if (!port || closing) return;
    closing = true; refresh();
    try { if (reader) await reader.cancel(); } catch { /* Device may be gone. */ }
    if (reading) await reading;
    reading = null;
  }
  $("connect").addEventListener("click", async () => {
    if (port) { await disconnect(); return; }
    if (connecting) return;
    if (!navigator.serial || !window.isSecureContext) {
      notice("Web Serial indisponível. Abra esta página no Chrome ou Edge do computador, como arquivo local ou em http://localhost:8000.", true); return;
    }
    stopDemo(); connecting = true; refresh();
    let selected;
    try {
      selected = await navigator.serial.requestPort();
      await selected.open({ baudRate: Number($("baud").value), bufferSize: 16384, flowControl: "none" });
      port = selected; closing = false;
      machine.reset(); parser = new LineDecoder(receive); clearLog(); lastPacket = 0;
      notice("Porta aberta. Aguardando @XC241 do firmware; confirme a velocidade e a configuração do console.");
      reading = readPort(selected);
    } catch (error) {
      if (selected && selected.readable) { try { await selected.close(); } catch {} }
      if (error.name !== "NotFoundError") notice(`Não foi possível abrir a porta: ${error.message}. Feche o monitor serial do ESP-IDF e tente novamente.`, true);
      else notice("Seleção de porta cancelada. Clique em conectar para tentar novamente.");
    } finally { connecting = false; refresh(); }
  });
  function clearLog() { $("events").replaceChildren(); logEmpty = true; }
  $("clear-log").addEventListener("click", clearLog);
  function stopDemo() {
    if (!demo) return;
    demo = null; machine.reset(); lastPacket = 0; clearLog();
    $("demo").textContent = "Ver demonstração";
    notice("Demonstração encerrada. Conecte o ESP para acompanhar a máquina.");
  }
  $("demo").addEventListener("click", () => {
    if (demo) { stopDemo(); return; }
    if (port || connecting) return;
    machine.reset(); clearLog();
    demo = { started: performance.now(), lastStep: 0,
      frame: { v: 1, boot: 241, seq: 0, ms: 0, motor: 1, inputs: 112, pulses: 0, detected: [0, 0, 0, 0], diverted: [0, 0, 0], dropped: 0, event: "boot", belt: [0, 0, 0, 0, 0, 0, 0], step: 0, step_ms: 1000, phase_ms: 0 } };
    $("demo").textContent = "Sair da demonstração";
    notice("DEMONSTRAÇÃO · Dados ilustrativos gerados nesta página. Nenhuma conexão com a máquina.", true);
  });
  function demoTick(now) {
    const elapsed = (now - demo.started) / 1000, f = demo.frame;
    f.motor = elapsed % 2 < 1 ? 1 : 0;
    f.phase_ms = Math.floor((elapsed % 1) * 1000);
    f.step = Math.floor((elapsed + 1) / 2);
    if (f.step !== demo.lastStep) {
      demo.lastStep = f.step; f.belt.pop(); f.belt.unshift(0); f.pulses = 0;
      if (f.step % 3 === 1) { const type = Math.floor(f.step / 3) % 2 + 1; f.belt[0] = type; f.detected[0]++; if (type === 2) f.detected[1]++; }
      for (let i = 0; i < 3; i++) if (f.belt[(i + 1) * 2] === i + 1) { f.belt[(i + 1) * 2] = 0; f.diverted[i]++; f.pulses |= 1 << i; }
    }
    for (let i = 0; i < 3; i++) if (f.motor || f.phase_ms > [300, 500, 700][i]) f.pulses &= ~(1 << i);
    f.inputs = 112;
    if (!f.motor && f.belt[0]) f.inputs |= f.belt[0] === 2 ? 11 : 1;
    for (let i = 0; i < 3; i++) if (f.pulses & (1 << i)) f.inputs &= ~(1 << (i + 4));
    f.ms = Math.floor(elapsed * 1000); f.seq++;
    receive({ ...f, detected: [...f.detected], diverted: [...f.diverted], belt: [...f.belt] });
  }
  const svgNS = "http://www.w3.org/2000/svg";
  function drawPieces() {
    const group = $("pieces");
    const existing = new Map([...group.children].map(node => [Number(node.dataset.id), node]));
    for (const p of machine.pieces) {
      let node = existing.get(p.id);
      if (!node) {
        node = document.createElementNS(svgNS, "g"); node.dataset.id = p.id;
        const body = document.createElementNS(svgNS, "rect"); body.setAttribute("rx", "5"); body.setAttribute("stroke-width", "2");
        const label = document.createElementNS(svgNS, "text"); label.setAttribute("text-anchor", "middle"); label.setAttribute("y", "5"); label.setAttribute("fill", "#0d2420"); label.setAttribute("font-size", "12"); label.setAttribute("font-weight", "700");
        node.append(body, label); group.append(node);
      }
      existing.delete(p.id);
      const size = [31, 41, 51][p.size], color = p.metal ? "#b8c9d2" : ["#65e4b0", "#edc778", "#b5a5f5"][p.size];
      const fall = p.fall === null ? 0 : Math.min(1, p.fall / 0.8);
      node.setAttribute("transform", `translate(${96 + p.x * 900},${231 + fall * fall * 137}) scale(${1 - fall * 0.4}) rotate(${fall * 32})`);
      node.setAttribute("opacity", String(1 - fall));
      const body = node.firstChild;
      body.setAttribute("x", String(-size / 2)); body.setAttribute("y", String(-size / 2)); body.setAttribute("width", size); body.setAttribute("height", size); body.setAttribute("fill", color); body.setAttribute("stroke", p.metal ? "#ffffff" : color);
      node.lastChild.textContent = `${p.id}${p.metal ? "M" : ""}`;
    }
    existing.forEach(node => node.remove());
    $("tread").setAttribute("patternTransform", `translate(${machine.belt} 0)`);
    for (let i = 0; i < 3; i++) $( `arm-${i}`).classList.toggle("active", !!(machine.pulses & (1 << i)) && isFresh());
    $("sensor-beam").setAttribute("opacity", isFresh() && (machine.inputs & 15) ? "1" : ".3");
  }
  function isFresh() { return !!lastPacket && performance.now() - lastPacket < 1500; }
  function refresh() {
    const fresh = isFresh(), active = !!demo || !!port;
    const moving = fresh && machine.motor;
    $("connect").disabled = connecting || closing;
    $("connect").textContent = connecting ? "Abrindo porta…" : closing ? "Desconectando…" : port ? "Desconectar" : "⌁ Conectar ao ESP";
    $("demo").disabled = !!port || connecting;
    $("baud").disabled = active || connecting;
    $("link-state").textContent = demo ? "Demonstração" : port ? fresh ? "Conectada" : "Aguardando dados" : "Desconectada";
    $("link-detail").textContent = demo ? "Dados ilustrativos · sem máquina" : fresh ? "Telemetria USB recebida" : port ? "Porta aberta · sem telemetria recente" : "Aguardando a porta serial";
    $("link-dot").classList.toggle("live", fresh && !demo);
    $("motor-state").textContent = fresh ? moving ? "Em movimento" : "Parada" : "Sem sinal";
    $("motor-state").style.color = moving ? "var(--green)" : "";
    $("motor-detail").textContent = fresh ? moving ? "Saída do motor ligada · ie" : "Saída do motor desligada · fe" : "Estado atual desconhecido";
    $("piece-count").replaceChildren(document.createTextNode(`${machine.pieces.filter(p => p.fall === null).length} `));
    const pieceUnit = document.createElement("em"); pieceUnit.textContent = "peças"; $("piece-count").append(pieceUnit);
    $("buffer-count").replaceChildren(document.createTextNode(`${machine.delivered} `));
    const bufferUnit = document.createElement("em"); bufferUnit.textContent = "peças"; $("buffer-count").append(bufferUnit);
    $("recognition").textContent = machine.lastRecognition;
    const status = $("flow-status"); status.textContent = demo ? "DEMONSTRAÇÃO" : fresh ? moving ? "ESTEIRA EM MOVIMENTO" : "ESTEIRA PARADA" : "AGUARDANDO SINAL";
    status.classList.toggle("running", moving && !demo); status.classList.toggle("demo", !!demo);
    $("diagram-state").textContent = fresh ? moving ? "MOTOR ON →" : "MOTOR OFF ■" : "SEM TELEMETRIA";
    for (let i = 0; i < 8; i++) {
      const node = $(`sensor-${i}`), high = i === 7 ? !!(machine.pulses & 8) : !!(machine.inputs & (1 << i));
      node.classList.toggle("active", fresh && high); node.querySelector(".sensor-level").textContent = fresh ? high ? "1" : "0" : "—";
    }
    while (machine.messages.length) {
      const message = machine.messages.shift();
      if (logEmpty) { $("events").replaceChildren(); logEmpty = false; }
      const item = document.createElement("li"), time = document.createElement("time"), code = document.createElement("b"), description = document.createElement("span");
      time.textContent = new Date().toLocaleTimeString("pt-BR"); code.textContent = message.code; description.textContent = message.text;
      item.append(time, code, description); $("events").prepend(item);
      if (message.code === "BUFFER") $("arrival").textContent = message.text;
      while ($("events").children.length > 70) $("events").lastChild.remove();
    }
    const f = machine.frame;
    $("memory").textContent = f ? `[ ${f.belt.map(type => ["·", "P", "M", "G"][type]).join(" | ")} ]` : "[ · | · | · | · | · | · | · ]";
    $("step-detail").textContent = f ? `Passo ${f.step} · fase de ${f.step_ms} ms. ¹ O pulso rápido de sm é capturado pela interrupção do ESP; o indicador mostra o nível amostrado.` : "Aguardando o primeiro passo.";
    $("packet-info").textContent = f ? `PACOTE ${f.seq} · ESP ${(f.ms / 1000).toFixed(1)} s · DESCARTES ${f.dropped} · LACUNAS ${machine.missed} · INVÁLIDOS ${parser.invalid}` : "Nenhum pacote recebido";
    if (port && !fresh && lastPacket) notice("Telemetria interrompida há mais de 1,5 s. Movimento congelado; verifique o cabo e o firmware.", true);
  }
  let nextUi = 0, nextDemo = 0;
  function animate(now) {
    const delta = Math.min((now - lastAnimation) / 1000, 0.1); lastAnimation = now;
    if (demo && now >= nextDemo) { demoTick(now); nextDemo = now + 80; }
    if (isFresh()) machine.advance(delta);
    drawPieces();
    if (now >= nextUi) { refresh(); nextUi = now + 100; }
    requestAnimationFrame(animate);
  }
  document.addEventListener("visibilitychange", () => { lastAnimation = performance.now(); });
  if (!navigator.serial) notice("Este navegador não oferece Web Serial. Use Chrome ou Edge no computador para conectar o ESP; a demonstração está disponível aqui.", true);
  refresh(); requestAnimationFrame(animate);
})();
