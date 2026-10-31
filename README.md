# ioBroker.ecoflow-gruppen

Ordnet **Ecoflow-Geräte** (z. B. PowerStream) anhand ihrer Seriennummer oder der Geräte-ID der Quell-Instanz frei wählbaren **Gruppen** zu, spiegelt Soll- und Ausgangsleistung und bildet pro Gruppe die **Summe der Ausgangsleistung**.  
Schreibzugriffe auf den Sollwert werden automatisch an das passende Gerät im Ecoflow-Adapter weitergereicht.

## Funktionen

- **Gruppen frei konfigurierbar:** Tabelle mit Gruppe, Seriennummer und/oder Geräte-ID der Quelle, Anzeigename (`WR1`, `WR2`, …) wird je Gruppe in Tabellenreihenfolge automatisch vergeben.
- **Mehrere Quell-Instanzen** gleichzeitig (kommagetrennt, z. B. `ecoflow-mqtt.0,ecoflow-mqtt.1`); auch `ecoflow-ps-ble.0` (siehe unten).
- **Spiegeln:** `permanentWatts` → `Power` (Sollwert), `invOutputWatts` → `InvOutputWatts`; Seriennummer und Geräte-ID werden unabhängig von Groß-/Kleinschreibung erkannt.
- **Rückweg:** Schreibt eine Automatisierung auf `<gruppe>.<WRn>.Power` (ack=false), wird der Wert an den beschreibbaren Quell-Datenpunkt des Ecoflow-Adapters weitergegeben.
- **Schutz:** Sollwerte unter 0 W oder über der konfigurierten Obergrenze werden begrenzt, ungültige Werte verworfen.
- **Skalierung** für Soll- und Ausgangswert getrennt konfigurierbar.
- **Stale-Timeout (optional):** Geräte ohne Update seit X Sekunden zählen in der Gruppensumme als 0 W. `info.connection` zeigt, ob mindestens ein Gerät aktuelle Daten liefert.
- **Eigener Namensraum:** Alle Datenpunkte liegen unter `ecoflow-gruppen.<Instanz>.*`.
- **Aufräumen beim Start:** Nicht mehr konfigurierte Datenpunkte werden entfernt (abschaltbar).
- **Eingabeprüfung:** Ungültige oder doppelte Einträge (weder Seriennummer noch Geräte-ID, Sonderzeichen in der Gruppe, reservierter Name `info`) werden mit Warnung übersprungen.

## Installation

1. ioBroker Admin → Adapter → Experten-Modus → „Adapter aus eigener URL installieren":  
   `https://github.com/lars752/ioBroker.ecoflow-gruppen`  
   Alternativ: `iobroker url https://github.com/lars752/ioBroker.ecoflow-gruppen`
2. Instanz anlegen und konfigurieren.

**Voraussetzungen:** Node.js ≥ 18, js-controller ≥ 5.0.19, Admin ≥ 6.12.2, laufender Ecoflow-Adapter.

## Konfiguration

| Einstellung | Standard | Bedeutung |
|---|---|---|
| Quell-Instanzen | `ecoflow-mqtt.0` | Instanzen des Ecoflow-Adapters, kommagetrennt |
| Skalierung Sollwert | 1 | Faktor Quellwert → Watt |
| Skalierung Ausgangsleistung | 1 | Faktor Quellwert → Watt |
| Maximale Sollleistung | 800 W | Obergrenze für Schreibzugriffe, 0 = keine Begrenzung |
| Stale-Timeout | 0 s | Sekunden bis ein Gerät als 0 W zählt, 0 = deaktiviert |
| Aufräumen beim Start | an | nicht mehr konfigurierte Datenpunkte löschen |
| Weitergaben im Log | aus | Sollwert-Weitergaben als `info` statt `debug` protokollieren |
| Tabelle | leer | pro Gerät: Gruppe sowie Seriennummer und/oder Geräte-ID der Quelle (mindestens eines von beiden) |

Der Knopf **„Geräte der Quell-Instanzen einlesen"** ergänzt die Tabelle um erkannte Seriennummern bzw. Geräte-IDs. Die **Gruppe** trägst du anschließend selbst ein – Zeilen ohne Gruppe werden ignoriert.  
Neue Geräte am Ende der Gruppe eintragen, damit bestehende Namen unverändert bleiben. Änderungen starten die Instanz neu.

## Betrieb mit ioBroker.ecoflow-ps-ble

Der Adapter [ioBroker.ecoflow-ps-ble](https://github.com/lars752/ioBroker.ecoflow-ps-ble) legt seine Datenpunkte unter `ecoflow-ps-ble.<N>.<Geräte-ID>.inverter_heartbeat.*` ab, wobei die Geräte-ID frei vergeben wird (z. B. `PS1`). Dafür:

1. Als **Quell-Instanz** `ecoflow-ps-ble.0` eintragen.
2. In der Tabelle pro PowerStream die **Geräte-ID** (z. B. `PS1`) eintragen. Die Seriennummer ist optional; wird sie zusätzlich eingetragen, passt auch eine Geräte-ID, die der Seriennummer entspricht.
3. Die Weitergabe des Sollwerts funktioniert wie bei anderen Quellen: Ein Schreibzugriff auf `<gruppe>.<WRn>.Power` (ack=false) setzt `permanentWatts` im ps-ble-Adapter. Der Quell-Datenpunkt muss beschreibbar sein.

Die Datenpunkte unter `<gruppe>.<WRn>` eignen sich direkt als Wechselrichter-Gruppe für [ioBroker.nulleinspeisung](https://github.com/lars752/ioBroker.nulleinspeisung).

## Datenpunkte (`ecoflow-gruppen.0.*`)

| Datenpunkt | Inhalt |
|---|---|
| `<gruppe>.WR<n>.Power` | Sollwert in W (**schreibbar**, wird an die Quelle weitergegeben) |
| `<gruppe>.WR<n>.InvOutputWatts` | Ausgangsleistung des Geräts in W |
| `<gruppe>.info.Total_Power` | Summe der Ausgangsleistung aller Geräte der Gruppe |
| `<gruppe>.info.Count` | Anzahl konfigurierter Geräte der Gruppe |
| `info.connection` | `true`, solange mindestens ein Gerät aktuelle Daten liefert |

## Import / Export der Konfiguration

Im Reiter **„Import / Export"** der Instanz:

- **Export:** schreibt die aktuelle Konfiguration als JSON in das Textfeld.
- **Import:** JSON einfügen und „JSON aus dem Textfeld importieren" drücken. Die Werte erscheinen im Formular, danach „Speichern und schließen".

Ungültige Zeilen, fehlerhaftes JSON oder der Export einer anderen Adapterart werden abgelehnt. Fehlende Felder werden mit Standardwerten ergänzt.

```json
{
  "adapter": "ecoflow-gruppen",
  "version": 1,
  "config": {
    "sourceAdapters": "ecoflow-mqtt.0",
    "staleTimeoutSec": 0,
    "pruneOnStart": true,
    "powerScale": 1,
    "outputScale": 1,
    "maxPowerW": 800,
    "logWrites": false,
    "devices": [
      { "group": "pv_dach", "serial": "<Seriennummer>" },
      { "group": "haus", "serial": "", "sourceId": "PS1" }
    ]
  }
}
```

## Entwicklung

```bash
npm install
npm test     # läuft ohne ioBroker-Instanz
```

Struktur: `lib/model.js` (Konfiguration, Datenmodell), `lib/core.js` (Zuordnung, Summen, Rückweg), `lib/configio.js` (JSON-Import/-Export), `main.js` (Adapter).  
Der Workflow `.github/workflows/test.yml` führt die Tests bei jedem Push auf Node 18, 20 und 22 aus.

## Lizenz

MIT
