# ioBroker.homekit-easy

**HomeKit Easy** – ioBroker-Datenpunkte in Apple Home (iPhone, iPad, Mac, Apple Watch, Siri),
so einfach wie möglich: Gerät anlegen, Typ wählen (z. B. „Licht“, „Rollladen“, „Kontakt“),
Datenpunkt im Objekt-Browser anklicken, speichern. Fertig. Kameras und die Türklingel aus dem
livecam-Adapter erscheinen mit Live-Bild in der Home-App.

Läuft komplett lokal (HomeKit Accessory Protocol über das eigene Netz), keine Cloud.

## Installation

```
iob url https://github.com/andreaslampl/ioBroker.homekit-easy
```

Für Kameras muss ffmpeg auf dem ioBroker-Rechner installiert sein (`sudo apt install ffmpeg`,
ist schon da, wenn livecam läuft).

Instanz anlegen, dann die Einrichtungsseite über den Link der Instanz (Weltkugel) öffnen:
`http://<ioBroker-IP>:8100/`

## Mit Apple Home koppeln

1. Einrichtungsseite öffnen – links stehen QR-Code und Code (xxx-xx-xxx).
2. iPhone: Home-App → **＋** → **Gerät hinzufügen** → QR-Code scannen
   (oder „Weitere Optionen…“ → „ioBroker“ antippen und den Code eintippen).
3. Hinweis „Nicht zertifiziertes Gerät“ mit **Trotzdem hinzufügen** bestätigen.
4. Räume zuweisen – fertig.

Das iPhone muss im selben Netz (WLAN) wie ioBroker sein. Für den Zugriff von unterwegs und für
Automationen braucht Apple Home eine Steuerzentrale (HomePod oder Apple TV).

Neue Geräte erscheinen nach „Speichern“ automatisch in Apple Home, ohne neu zu koppeln.
„Kopplung zurücksetzen“ erzeugt einen neuen Code; danach die Bridge in der Home-App entfernen und
neu hinzufügen.

## Gerätetypen

| Typ | Datenpunkte | Optionen |
| --- | --- | --- |
| Licht (Ein/Aus), Steckdose, Schalter | Schalten, Status (optional) | invertiert |
| Dimmer | Helligkeit 0–100, Schalten (optional), Status | |
| Farblicht (RGBW) | Rot, Grün, Blau, Weiß (optional), Helligkeit (optional, Shelly `gain`), Ein/Aus (optional) | Wertebereich 0–255 oder 0–100 % |
| Ventilator / Lüftung | Ein/Aus, Stufe 0–100 (optional), Status | |
| Rollladen / Jalousie / Markise | Position in % und/oder Auf/Ab fahren (true = ab, false = auf), Stopp (optional), Position-Status | 100 = zu, Auf/Ab umgekehrt |
| Garagentor / Tor | Befehl, Status offen/zu | Impuls oder Auf/Zu, Status invertiert |
| Türschloss | Schalten (true = zu), Status | invertiert |
| Heizung / Thermostat | Solltemperatur, Isttemperatur, Heizt gerade (optional) | Min, Max, Schritt |
| Temperatur, Luftfeuchte, Helligkeit (Lux) | Messwert | |
| CO₂ | ppm | Grenzwert (Standard 1200) |
| Kontakt, Bewegung, Anwesenheit, Rauch, Wasser/Leck | Meldung | invertiert |
| Alarmanlage | Status, Befehl (optional), Alarm ausgelöst (optional) | Werte für Aus/Abwesend/Zuhause/Nacht |
| Taster | Datenpunkt, der bei Tastendruck kommt | für Automationen in Home |
| Kamera | Kamera aus livecam | eigene RTSP-Quelle (optional) |
| Türklingel mit Kamera | Kamera aus livecam, Klingel-Datenpunkt | eigene RTSP-Quelle (optional) |

**Rollladen mit Auf/Ab-Datenpunkt:** Es reicht die Position in %, nur der Auf/Ab-Datenpunkt (z. B. KNX 1-Bit:
1 = hinunter, 0 = hinauf) oder beides. Mit beidem fährt „ganz auf“ / „ganz zu“ über Auf/Ab und Zwischenstellungen
über die Position. Nur mit Auf/Ab fährt jede Stellung unter 50 % ganz zu, darüber ganz auf.

Grundsätzlich: Apple Home schreibt **nur** in Datenpunkte, die als „Schalten/Befehl/Position…“
eingetragen sind. Reine Sensoren sind nur lesbar.

## Farblicht (RGBW) – KNX und Shelly

Typ **„Farblicht (RGBW)“**: in Apple Home mit Farbrad und Weißtönen, bei Alexa „Alexa, Wohnzimmer
rot“, „… warmweiß“, „… auf 40 Prozent“.

| | KNX (z. B. RGBW-Aktor) | Shelly RGBW2 / Bulb |
| --- | --- | --- |
| Rot, Grün, Blau, Weiß | die 4 Kanal-Objekte | `color.red/green/blue/white` |
| Helligkeit | leer lassen (die Kanäle werden skaliert) | `color.gain` |
| Ein/Aus | Schalt-Objekt (optional) | `color.Switch` |
| Wertebereich | 0–100 % (DPT 5.001) oder 0–255 (DPT 5.010) | 0–255 |

Der Weißanteil einer Farbe geht auf den W-Kanal (reines Weiß = nur W), Weißtöne kommen vom W-Kanal
mit etwas Rot bzw. Blau. Ist die Leuchte aus, wird zuerst eingeschaltet und dann die Farbe gesendet.

## Alexa (Sprachsteuerung, lokal)

Dieselben Geräte lassen sich auch mit **Alexa** steuern – ohne Skill, ohne Amazon-Konto-Verknüpfung
und ohne Cloud-Abo. HomeKit Easy meldet sich im Heimnetz wie eine Philips-Hue-Bridge; die Echo-Geräte
finden sie selbst.

1. Beim Gerät den Haken **„auch für Alexa“** setzen und **Speichern**.
2. Zum Echo sagen: **„Alexa, suche Geräte“** (oder Alexa-App → Geräte → ＋ → Andere → Geräte suchen).
3. Fertig: „Alexa, Licht Wohnzimmer ein“, „Alexa, Essen auf 30 Prozent“, „Alexa, Fernsehen aus“.
   Die Geräte erscheinen in der Alexa-App als **Lampen** (Schalter/Steckdosen als Stecker) und lassen
   sich Räumen zuordnen und in **Routinen** verwenden.

| Gerätetyp | Alexa |
| --- | --- |
| Licht, Dimmer | ein/aus, Helligkeit in Prozent |
| Farblicht (RGBW) | ein/aus, Prozent, Farben, Weißtöne |
| Schalter, Steckdose | ein/aus (z. B. Szenen) |
| Ventilator | ein/aus, mit Stufen-Datenpunkt auch Prozent |
| Rollladen | „ein“ = auf, „aus“ = zu, „auf 30 Prozent“ = 30 % offen |

Heizung, Sensoren, Schlösser, Garagentore und Alarmanlagen gibt es für Alexa **nicht** – Alexa kennt
bei einer Hue-Bridge nur Lampen, und Türen/Alarm sollen nicht ohne PIN per Zuruf aufgehen.

Voraussetzungen: **Port 80** am ioBroker-Rechner muss frei sein (die Echos suchen nur dort; prüfen mit
`sudo ss -tlnp | grep ':80 '`), Echo und ioBroker im selben Netz. Die Einrichtungsseite zeigt, ob die
Alexa-Bridge läuft und wann zuletzt ein Echo nachgefragt hat. Neue Geräte: wieder „Alexa, suche Geräte“.

## Zusammen mit SmartView

Wer auch den Adapter **SmartView** nutzt, muss nichts doppelt anlegen:

- In SmartView hat jede Kachel (Licht, Schalter, Dimmer, Rollladen, Heizung, Anzeige, Kamera) den Haken
  **„auch in Apple Home“**. Beim Speichern in SmartView legt homekit-easy das Gerät an und hält es aktuell;
  Haken weg oder Kachel gelöscht = das Gerät verschwindet hier wieder. In der Liste sind diese Geräte mit
  **SmartView** markiert – Name und Datenpunkte bitte in SmartView ändern. „In Apple Home anzeigen“ und
  „auch für Alexa“ stellst du hier ein, das bleibt.
- Oder von hier aus: **„Aus SmartView …“** (neben „＋ Gerät“) zeigt die passenden SmartView-Kacheln; anhaken,
  bei Schaltern wählen ob Licht/Steckdose/…, „Übernehmen“. SmartView setzt dort den Haken und legt die Geräte hier an.
- Umgekehrt: Wer hier angefangen hat, holt seine Geräte in SmartView mit **„+ Kachel“ → „Aus homekit-easy
  übernehmen …“** als Kacheln. Sie bleiben verknüpft – ändert man die Kachel, ändert sich das Gerät hier mit.


Die Kameras kommen aus dem Adapter **livecam** (`livecam.0.cameras.<name>`). HomeKit Easy holt
Standbilder über livecam und wandelt das Live-Bild mit ffmpeg in H.264 für Apple um. Wer eine
direkte RTSP-Adresse der Kamera einträgt (Option „Quelle“), bekommt meist ein flüssigeres Bild.
Ton wird derzeit nicht übertragen.

Die Türklingel: wenn der Klingel-Datenpunkt auf true/1 geht, meldet Apple Home „Es hat
geklingelt“ mit Bild am iPhone und an der Apple Watch.

## Einstellungen der Instanz

| Einstellung | Standard | Bedeutung |
| --- | --- | --- |
| Port der Einrichtungsseite | 8100 | |
| HomeKit-Port | 51828 | Muss im Netz erreichbar sein (Firewall) |
| Name der Bridge | ioBroker | So heißt sie in der Home-App |
| Adresse für Links | – | Leer = automatisch |
| Zugriffsschlüssel | – | Schützt die Einrichtungsseite (sie zeigt den Code). Aufruf einmal mit `?key=...` |
| ffmpeg | ffmpeg | Pfad zu ffmpeg |

## Grenzen

- Eine Bridge kann höchstens 149 Geräte enthalten (Apple-Vorgabe).
- Kameras ohne Ton und ohne Gegensprechen.
- Getestet mit einem echten HomeKit-Client (hap-controller) – mit dem iPhone noch nicht.

## Changelog

### 0.4.0
- Zusammen mit SmartView: Kacheln mit „auch in Apple Home“ werden hier automatisch angelegt, SmartView kann die Geräte von hier als Kacheln übernehmen.

### 0.3.0
- Neuer Typ „Farblicht (RGBW)“ für KNX und Shelly: Apple Home (Farbrad, Weißtöne) und Alexa (Farben, warmweiß).

### 0.2.1
- Dimmer mit eigenem Ein/Aus-Datenpunkt (KNX): erst Ein, dann die Helligkeit; Ein/Aus richtet sich nach dem zuletzt geänderten Datenpunkt (Alexa und Apple Home).

### 0.2.0
- Alexa: Haken „auch für Alexa“ pro Gerät; lokale Hue-Emulation (Licht, Dimmer, Schalter, Steckdose, Ventilator, Rollladen).

### 0.1.0
- Erste Version: Einrichtungsseite mit Objekt-Browser, 22 Gerätetypen, Kameras und Türklingel aus livecam.

## Lizenz

MIT. Verwendet [HAP-NodeJS](https://github.com/homebridge/HAP-NodeJS) (Apache-2.0).
