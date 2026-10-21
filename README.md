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
| Ventilator / Lüftung | Ein/Aus, Stufe 0–100 (optional), Status | |
| Rollladen / Jalousie / Markise | Position, Stopp (optional), Position-Status | 100 = zu |
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

Grundsätzlich: Apple Home schreibt **nur** in Datenpunkte, die als „Schalten/Befehl/Position…“
eingetragen sind. Reine Sensoren sind nur lesbar.

## Kameras

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

### 0.1.0
- Erste Version: Einrichtungsseite mit Objekt-Browser, 22 Gerätetypen, Kameras und Türklingel aus livecam.

## Lizenz

MIT. Verwendet [HAP-NodeJS](https://github.com/homebridge/HAP-NodeJS) (Apache-2.0).
