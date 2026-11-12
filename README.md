# L'unico telecomando Android di cui avrai bisogno

App Android + firmware per i blaster IR Wi-Fi Tuya **S18 / S06** (chip BK7231N con [OpenBeken](https://github.com/openshwprojects/OpenBK7231T_App)) e per il **blaster IR del telefono** (Xiaomi, POCO, Redmi…). Tutto in locale, senza cloud Tuya.

> *English summary:* Android app + custom OpenBeken firmware for Tuya S18/S06 Wi-Fi IR blasters. Offline IR library of ~8,900 models (Flipper-IRDB), learning, "mystery model" identification, Gree/Vaillant AC control, sending from the blaster and/or the phone's IR emitter, automations running on the device, and local Alexa control (Hue emulation, no cloud, an Echo is enough). MIT licensed.

## Cosa fa

- **Libreria offline**: ~8.900 modelli e ~297.000 codici (TV, decoder, condizionatori, luci LED, proiettori, soundbar…) da [Flipper-IRDB](https://github.com/Lucaslhm/Flipper-IRDB). Ricerca per marca/modello e **"Trova il codice giusto"** che prova i codici di accensione uno alla volta.
- **Impara** da qualsiasi telecomando e **identifica i modelli misteriosi**: premi qualche tasto e l'app trova i modelli della libreria con gli stessi codici (stesso produttore). Indica anche le parentele note (Vestel, TCL, Hisense, Gree…).
- **Telecomandi completi**: layout con tastierino numerico e frecce, **"Completa i tasti mancanti"** (prende numeri, frecce, menu dai modelli compatibili per maggioranza), modifica in blocco (elimina, sposta, copia, trova doppioni).
- **Condizionatori Gree** (e Vaillant climaVAIR, Saunier Duval, Tosot, Sinclair…): pannello completo con accensione, modalità, temperatura, ventola, oscillazione.
- **Due trasmettitori**: S18, telefono o **entrambi insieme** (più portata). I codici che l'S18 non sa inviare partono dal telefono.
- **Automazioni sull'S18**: a orario o "quando ricevo questo tasto IR". Girano anche a telefono spento. Quelle con codici solo-telefono le gestisce il telefono.
- **Alexa in locale** (basta un Echo, niente skill né cloud): fino a 22 dispositivi.
  - *Acceso/spento*: "Alexa, accendi Decoder" → qualsiasi sequenza di tasti.
  - *Condizionatore*: "Alexa, imposta Clima al 22 percento" = 22 °C. Varianti per caldo/deumidifica/ventola/oscillazione.
  - *Canale TV*: "Alexa, imposta Canale TV al 5 percento" = canale 5.
  - Con le **Routine** dell'app Alexa ogni frase può attivare questi dispositivi.
- **Ritrova l'S18** da solo se cambia IP (lo riconosce dal MAC), due reti Wi-Fi sull'S18, guida di recupero.

## Cosa serve

- Un S18 (o simile BK7231N) con il **firmware di questo progetto** → [firmware/README.md](firmware/README.md). Funziona anche col firmware OpenBeken ufficiale, ma senza condizionatori/codici raw e senza i dispositivi Alexa multipli.
- Android 8 o successivo. Il blaster IR del telefono è facoltativo.

## Installazione rapida

1. Scarica l'APK e il firmware dalle [Release](../../releases).
2. Installa il firmware sull'S18 (OTA) e segui i 3 passi "Dopo l'installazione" in [firmware/README.md](firmware/README.md).
3. Installa l'APK (permetti "installa app sconosciute"). Al primo avvio l'app cerca l'S18 sulla rete Wi-Fi.
4. Telecomandi → **+ Nuovo telecomando** → *Cerca nella libreria* oppure *Impara*.
5. Per Alexa: Automazioni → **+ Nuovo dispositivo Alexa** → **Applica** → "Alexa, rileva dispositivi".

Su Xiaomi/POCO, per le automazioni gestite dal telefono: Impostazioni → App → IR Remote → *Avvio automatico* attivo e Batteria *Nessuna restrizione*.

## Se l'S18 non si raggiunge più

- **Cambia IP** (blackout, router): l'app lo ritrova da sola. Meglio comunque riservargli un IP fisso nel router.
- **Altra rete / fuori casa**: l'S18 non è raggiungibile, il blaster del telefono funziona ovunque; le automazioni dell'S18 continuano a casa.
- **Nuovo router o password**: prima del cambio, Impostazioni → *Reti Wi-Fi dell'S18* → rete di riserva. Se è tardi: stacca e riattacca l'S18 **5 volte di fila** (acceso ~2 s ogni volta) → crea la rete `OpenBK7231N_…` → collegati e apri `http://192.168.4.1` → Config → WiFi.

Android non permette a nessuna app di leggere le reti Wi-Fi salvate nel telefono, quindi la rete va inserita a mano.

## Compilare l'app

```bash
cd android
./gradlew assembleDebug        # Windows: gradlew.bat assembleDebug
# APK in android/app/build/outputs/apk/debug/
```
Serve JDK 17+ e Android SDK (piattaforma 36): crea `android/local.properties` con `sdk.dir=/percorso/Android/Sdk`.

La libreria è già inclusa. Per rigenerarla da una versione nuova di Flipper-IRDB:
```bash
git clone --depth 1 https://github.com/Lucaslhm/Flipper-IRDB.git /tmp/irdb
python3 tools/build_library.py /tmp/irdb android/app/src/main/assets/lib
node tools/test_logic.js && python3 tools/check_patterns.py
```

## Come è fatto

- `android/` – app: WebView (HTML/JS in `assets/`) + Java per HTTP, blaster IR del telefono (`ConsumerIrManager`) e allarmi.
  - `assets/logic.js` – parti pure e testate: decodifica log, codici, generatore di segnali per il telefono (NEC, Samsung, Sony, RC5/RC6, Kaseikyo/Panasonic, Gree, raw), script `app.bat` per l'S18.
  - `assets/lib/` – libreria convertita (formato `IRSend` di OpenBeken o `RAW:<Hz>:<µs,...>`).
- `tools/` – conversione della libreria (con decodifica dei segnali raw in protocolli) e test (`test_logic.js`, `check_patterns.py`: i segnali generati in JS vengono ridecodificati da un decoder Python indipendente).
- `firmware/` – patch OpenBeken e guida alla compilazione.

## Limiti noti

- Il pannello condizionatore conosce il protocollo **Gree**. Altri condizionatori: cerca la marca nella libreria (molti hanno codici raw) o usa *Impara* se il protocollo è decodificabile.
- **Google Home** non controlla dispositivi solo locali: servirebbe un ponte cloud (es. Home Assistant).
- Alexa vede i dispositivi come luci: comandi possibili accendi/spegni/percentuale (+ routine).

## Licenza

MIT – vedi [LICENSE](LICENSE). Libreria IR: CC0 (Flipper-IRDB). Firmware: progetto OpenBeken, vedi [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
