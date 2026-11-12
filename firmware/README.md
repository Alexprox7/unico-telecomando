# Firmware per l'S18 (OpenBeken 1.18.321 + patch "irraw")

Il firmware ufficiale [OpenBeken](https://github.com/openshwprojects/OpenBK7231T_App) non sa trasmettere segnali IR "raw" (condizionatori, codici raw della libreria) e la sua emulazione Philips Hue per Alexa è incompleta. Le 6 patch in [`patches/`](patches/) aggiungono:

| Patch | Cosa fa |
|---|---|
| 0001 | comando `IRSendRaw <kHz> t1,t2,...` (tempi in µs, il primo è un impulso) e coda di trasmissione da 1024 elementi. Compila solo la versione BK7231N (sostituisce il workflow CI) |
| 0002 | `IRSendRaw @file`: legge i tempi da un file LittleFS (gli script accettano righe di max 255 caratteri) |
| 0003 | accetta "a capo" tra i valori |
| 0004 | API Hue completa: i canali 10–31 con un'etichetta e tipo `Toggle` o `Dimmer` diventano luci per Alexa (accendi/spegni/percentuale) |
| 0005 | `IRSendRaw @file:N`: invia la riga N del file (più codici in un blocco da 4 KB) |
| 0006 | SSDP: Wemo non "ruba" più le ricerche di Alexa, Wemo e Hue funzionano insieme |

Il binario già compilato è allegato alle [Release](../../../releases) (`OpenBK7231N_1.18.321_irraw.rbl` per l'OTA, `..._UA_...bin` / `..._QIO_...bin` per la prima installazione via seriale).

## Compilare con GitHub (nessun programma da installare)

1. Fai un fork di [openshwprojects/OpenBK7231T_App](https://github.com/openshwprojects/OpenBK7231T_App).
2. Crea un ramo dal tag `1.18.321` e applica le patch:
   ```bash
   git clone https://github.com/<tuo-utente>/OpenBK7231T_App.git && cd OpenBK7231T_App
   git fetch origin tag 1.18.321
   git checkout -b ir-raw 1.18.321
   git am /percorso/firmware/patches/*.patch
   git push origin ir-raw
   ```
3. Il push avvia l'azione **Build S18 IR raw** (file `.github/workflows/s18-irraw.yaml`, ~2 minuti). Dalla pagina della run scarica l'artefatto `OpenBK7231N_1.18.321_irraw`.

Il fork usato per questo progetto è [Alexprox7/OpenBK7231T_App, ramo `ir-raw`](https://github.com/Alexprox7/OpenBK7231T_App/tree/ir-raw).

## Compilare in locale (Linux o WSL)

```bash
sudo apt install -y build-essential python3 git
git clone https://github.com/openshwprojects/OpenBK7231T_App.git && cd OpenBK7231T_App
git checkout -b ir-raw 1.18.321
git am /percorso/firmware/patches/*.patch
make APP_VERSION=1.18.321_irraw APP_NAME=OpenBK7231N VARIANT=default OpenBK7231N
ls output/1.18.321_irraw/
```
Il `make` scarica da solo l'SDK Beken e il compilatore ARM.

## Installare

- **S18 che ha già OpenBeken**: pagina web dell'S18 → *Launch Web Application* → *OTA* → scegli il `.rbl` → *Start OTA*, poi riavvia. Da riga di comando:
  ```bash
  curl -X POST --data-binary @OpenBK7231N_1.18.321_irraw.rbl http://<ip-s18>/api/ota
  curl -X POST http://<ip-s18>/api/reboot
  ```
  Il bootloader verifica il file prima di installarlo; configurazione, pin e file restano.
- **S18 ancora col firmware Tuya**: serve la prima installazione via seriale (adattatore USB-TTL) del file `UA` con [BK7231GUIFlashTool](https://github.com/openshwprojects/BK7231GUIFlashTool), come per qualsiasi dispositivo OpenBeken. Vedi la [guida OpenBeken](https://github.com/openshwprojects/OpenBK7231T_App/blob/main/FLASHING.md).

## Dopo l'installazione (una volta)

1. **Pin**: sul nostro S18 il ricevitore è su **P8** e il LED IR su **P7**, al contrario del modello "S18" del database OpenBeken (P7/P26). Se la ricezione non va, il trucco è impostare per qualche minuto i pin liberi come `Counter_f` e vedere quale conta impulsi mentre premi un telecomando. Per il trasmettitore: `IREnable RXTX 1` + `IRSend NEC-BEEF-5A-0` → se il pin è giusto l'S18 riceve il proprio segnale.
2. **Spazio file**: `lfs_format 0x20000` (128 KB; **cancella i file**). Il firmware occupa ~524 KB dell'area OTA, quindi 128 KB lasciano ancora margine.
3. **Script di avvio** (`autoexec.bat`, dalla scheda *LittleFS* della web app):
   ```
   startDriver IR
   startDriver NTP
   setChannelType 1 Toggle
   SetChannelLabel 1 Alexa
   startDriver SSDP
   startDriver Wemo
   startDriver HUE
   exec app.bat
   ```
   `app.bat` e i file `irpk*.txt` li scrive l'app quando premi **Applica**.

## Comandi aggiunti

```
IRSendRaw 38 9000,4500,560,560,560,1690,560      # tempi in µs, portante in kHz
IRSendRaw @gree.txt                               # tempi letti da file
IRSendRaw @irpk0.txt:3                            # quarta riga del file
```
Emulazione Hue: `setChannelType 10 Dimmer` + `SetChannelLabel 10 "Clima"` → Alexa vede la luce "Clima"; "imposta al 22 percento" mette il canale 10 a 22 e `addChangeHandler Channel10 == 22 ...` fa il resto.
