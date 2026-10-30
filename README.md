# XC-241 · ESP32-S3 e monitor web por USB

A página `web/index.html` acompanha a máquina pelo cabo USB, sem Wi-Fi, servidor remoto ou bibliotecas externas. Mostra a esteira andando/parando, as peças reconhecidas, os três cilindros e a queda das peças para o buffer. O buffer não é desenhado: a peça cai, desaparece e gera uma mensagem.

A integração acompanha **a versão atual de `main/main.c`**, com movimento em passos, `esteira_mem[7]`, classificação por `sp` e pelo latch de `sm`, e braços nas posições 2, 4 e 6. O sensor grande continua desativado, como no código recebido. Por isso, a classificação atual produz peças pequenas e médias; peças grandes só aparecerão se o firmware efetivamente registrar esse tipo na memória. O monitor não cria outra regra de classificação. O sensor de metal é mostrado separadamente: o firmware não armazena material em `esteira_mem`.

## 1. Identifique a interface da PCB

O formato USB-C não determina o tipo de comunicação:

- **USB nativo:** D− e D+ do conector ligados aos GPIOs 19 e 20 do S3. Use o console **USB Serial/JTAG Controller**.
- **USB/UART:** existe na PCB um conversor, por exemplo CP210x, CH340/CH343 ou FTDI, ligado ao UART0. Use o console **Default: UART0**, com 115200 baud. Se o UART0 tiver pinos personalizados, configure-os em `menuconfig` conforme o esquema da PCB.
- **UART sem conversor:** os pinos TX/RX do processador não podem ser ligados diretamente a um cabo USB comum. É necessário um adaptador USB/UART compatível com os níveis elétricos da PCB.

Confira o esquema ou as trilhas da PCB e veja se a placa aparece como COM no Gerenciador de Dispositivos. Não é possível decidir a interface apenas pela descrição “processador em uma PCB”.

Os pinos definidos pelo usuário foram mantidos. Confirme que GPIO26 e GPIO27 estão disponíveis na variante de S3 usada; eles podem estar ligados à flash/PSRAM. O GPIO10 de retorno do braço grande também foi preservado: o código atual não o inclui na máscara de saídas nem o aciona. A visualização apenas exibe seu estado lógico, sem corrigir esse comportamento.

Referências: [USB Serial/JTAG no ESP32-S3](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/usb-serial-jtag-console.html), [pinagem e restrições dos GPIOs](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/peripherals/gpio.html).

## 2. Compile e grave o firmware

No terminal ESP-IDF, na raiz do projeto, configure o alvo `esp32s3` e a saída de console correspondente à PCB. Para uma configuração inicial por USB/UART:

```powershell
idf.py -D SDKCONFIG_DEFAULTS=config/uart.defaults set-target esp32s3
idf.py build
idf.py -p COM5 flash
```

Para USB nativo, substitua o primeiro comando por:

```powershell
idf.py -D SDKCONFIG_DEFAULTS=config/usb-native.defaults set-target esp32s3
```

Substitua `COM5` pela porta real. Os presets são configurações iniciais; se já existir um `sdkconfig`, confira o resultado em `idf.py menuconfig`, em **Component config → ESP-STDIO → Channel for console output** no ESP-IDF 6 (em versões anteriores, **ESP System Settings**). No UART, confira também 115200 baud. O preset de USB nativo usa Serial/JTAG, sem TinyUSB e sem alterar a pinagem.

Não deixe o monitor serial do ESP-IDF aberto junto com a página: ambos disputam a mesma porta. A máquina continua seguindo seu funcionamento original ao ligar e ao desconectar o navegador.

## 3. Abra a página

1. Abra `web/index.html` no **Chrome ou Edge do computador**. Nenhuma instalação de pacote é necessária.
2. Para conferir o desenho sem a máquina, clique em **Ver demonstração**. Esse modo está identificado na tela e usa dados ilustrativos, sem executar o firmware.
3. Com o firmware gravado, conecte um cabo USB **de dados**, encerre o monitor serial e clique em **Conectar ao ESP**.
4. Selecione a porta COM da placa e aguarde a telemetria. No UART, escolha a mesma velocidade configurada no console, normalmente 115200.

Se o navegador restringir Web Serial em arquivo local, sirva apenas a pasta da página:

```powershell
python -m http.server 8000 --bind 127.0.0.1 --directory web
```

Abra `http://localhost:8000`. Encerre o servidor com Ctrl+C quando terminar. O monitor funciona localmente e não transmite os estados da máquina para a nuvem.

## O que é real e o que é estimado

- **Informado pelo firmware:** comando do motor, níveis amostrados de `sp`/`sm`, entradas de metal e fins de curso após o debounce existente, saídas pulsadas, contador de passos, tempo de fase e conteúdo das sete posições de `esteira_mem`.
- **Posição nas paradas:** corresponde às posições da memória do firmware. As identidades visuais são preservadas entre passos consecutivos. Ao conectar no meio de uma operação, a página reconstrói as peças presentes na memória.
- **Animação entre paradas:** interpolação usando `ESTEIRA_PASSO`, sem encoder e sem medir velocidade física. Cada fase segue o tempo enviado pelo ESP. O desenho é esquemático.
- **Queda e contagem no buffer:** estimadas a partir da retirada da peça da memória e dos comandos dos cilindros. Não existe confirmação física de chegada ao buffer neste código. O contador começa nesta sessão; não é o total histórico da máquina.
- **Sensor médio:** a classificação utiliza o latch capturado pela interrupção original. Um pulso rápido pode não aparecer no indicador de nível da página, mas a classificação recebida da memória continua correta.

Após 1,5 segundo sem telemetria válida, a página congela a animação e marca o estado como desconhecido. Isso não envia comando de parada ao ESP. Reinícios, lacunas de sequência e descartes são identificados; quando passos inteiros são perdidos, as posições são reconstruídas usando a memória recebida, sem inventar os trajetos ausentes.

## Alterações no firmware

`main/telemetry.c` mantém uma cópia dos estados e envia linhas JSON prefixadas por `@XC241 ` no console já configurado. Logs existentes continuam habilitados e são ignorados pela página.

Os pontos adicionados a `main.c` apenas observam comandos do motor, início/fim dos pulsos e cópias de `esteira_mem` antes/depois dos descartes. As leituras de sensores destinadas à página ficam ao final do loop e não alimentam o controle. A ISR do sensor médio, classificação, deslocamento do vetor, tempos dos braços, configuração de GPIO e decisões de atuação foram preservados.

O loop coloca cópias em uma fila FreeRTOS com espera zero. A formatação e a escrita serial ficam em uma tarefa separada de prioridade baixa. Se a fila lotar, a telemetria descarta pacotes e contabiliza a perda; não espera pelo navegador. Existe um pequeno custo de CPU e memória da instrumentação; não se trata de uma garantia de tempo real certificado. Falhas de criação da fila/tarefa não interrompem o controle existente. A página só abre o leitor serial: não possui comandos para dirigir a máquina nem grava firmware.

## Verificação

```powershell
node --test web/model.test.cjs
node --check web/app.js
```

Os testes cobrem recepção fragmentada de serial, separação de logs, frames inválidos, reconhecimento pela memória, movimento/parada, cilindros simultâneos, queda, reinício, reconexão e recuperação após perda de pacotes. O teste físico exige a PCB conectada e o firmware gravado.
