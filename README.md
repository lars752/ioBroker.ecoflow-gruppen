# ioBroker.ecoflow-gruppen

Ordnet **Ecoflow-Geräte** (z. B. PowerStream) anhand ihrer **Seriennummer** Gruppen zu, spiegelt Soll- und Ausgangsleistung und bildet pro Gruppe die **Summe der Ausgangsleistung** (`invOutputWatts`).
Schreibzugriffe auf den Sollwert werden an das passende Gerät im Ecoflow-Adapter weitergereicht. Der Adapter ersetzt das Skript „Ecoflow Gruppen-Zuordnung (Multi-Adapter)“ (`0_userdata.0.Wechselrichter`).

## Funktionen
- **Gruppen in der Admin-Oberfläche:** Tabelle mit Gruppe und Seriennummer. Der Anzeigename wird automatisch vergeben (`WR1`, `WR2`, … je Gruppe in Tabellenreihenfolge).
- **Mehrere Quell-Instanzen** des Ecoflow-Adapters gleichzeitig (z. B. `ecoflow-mqtt.5,ecoflow-mqtt.6,ecoflow-mqtt.8`).
- **Spiegeln:** `permanentWatts` → `Power` (Sollwert), `invOutputWatts` → `InvOutputWatts`; die Seriennummer wird unabhängig von Groß-/Kleinschreibung erkannt.
- **Rückweg:** Schreibt ein Skript oder eine Visualisierung auf `<gruppe>.<WRn>.Power` (ack=false), wird der Wert an den beschreibbaren Quell-Datenpunkt des Ecoflow-Adapters weitergegeben. Die Quelle wird automatisch ermittelt.
- **Schutz:** Sollwerte unter 0 W oder über der konfigurierten Obergrenze (Standard 800 W) werden begrenzt, ungültige Werte verworfen.
- **Skalierung** für Soll- und Ausgangswert getrennt (z. B. 0,1 bei Einheit 0,1 W).
- **Stale-Timeout (optional):** Geräte ohne Update seit X Sekunden zählen in der Summe als 0 W. `info.connection` zeigt, ob mindestens ein Gerät aktuelle Daten liefert.
- **Eigener Namensraum:** Alle Datenpunkte liegen unter `ecoflow-gruppen.<Instanz>.*`. Nach `0_userdata.0` wird nichts geschrieben.
- **Aufräumen:** Nicht mehr konfigurierte Datenpunkte werden beim Start gelöscht (abschaltbar).
- **Effizient:** Es werden nur Datenpunkte der konfigurierten Geräte abonniert.
- **Prüfung der Eingaben:** Ungültige oder doppelte Zeilen (falsche Seriennummer, doppelte Seriennummer, Sonderzeichen in der Gruppe, reservierter Name `info`) werden mit Warnung übersprungen.

## Installation über GitHub
1. Auf GitHub ein **neues Repository `ioBroker.ecoflow-gruppen`** anlegen (Benutzer `lars752`).
2. ZIP entpacken und den **Inhalt** des Ordners `ioBroker.ecoflow-gruppen` (nicht den Ordner selbst) ins Hauptverzeichnis des Repositorys hochladen (Branch `main`). Danach müssen `package.json`, `io-package.json`, `main.js`, `lib/` und `admin/` direkt im Hauptverzeichnis sichtbar sein.
3. ioBroker Admin → Adapter → Experten-Modus → „Adapter aus eigener URL installieren“ → `https://github.com/lars752/ioBroker.ecoflow-gruppen`
   oder `iobroker url https://github.com/lars752/ioBroker.ecoflow-gruppen`
4. Instanz `ecoflow-gruppen.0` anlegen und konfigurieren.

Voraussetzungen: Node.js ≥ 18, js-controller ≥ 5.0.19, Admin ≥ 6.12.2, laufender Ecoflow-Adapter.

## Konfiguration
| Einstellung | Standard | Bedeutung |
|---|---|---|
| Quell-Instanzen | `ecoflow-mqtt.0` | Instanzen des Ecoflow-Adapters, kommagetrennt |
| Skalierung Sollwert / Ausgangsleistung | 1 / 1 | Faktor Quellwert → Watt |
| Maximale Sollleistung | 800 W | Obergrenze für Schreibzugriffe, 0 = keine |
| Stale-Timeout | 0 | Sekunden bis ein Gerät als 0 W zählt, 0 = aus |
| Aufräumen beim Start | an | nicht mehr konfigurierte Datenpunkte löschen |
| Weitergaben im Log | aus | Sollwert-Weitergaben als `info` statt `debug` |
| Tabelle | leer | pro Gerät: Gruppe und Seriennummer |

Der Knopf „Geräte der Quell-Instanzen einlesen“ ergänzt die Tabelle um gefundene Seriennummern; die **Gruppe** trägst du danach selbst ein (Zeilen ohne Gruppe werden ignoriert).
Neue Geräte am Ende der Gruppe eintragen, damit bestehende Namen gleich bleiben. Änderungen starten die Instanz neu.

## Datenpunkte (`ecoflow-gruppen.0.*`)
| Datenpunkt | Inhalt |
|---|---|
| `<gruppe>.WR<n>.Power` | Sollwert in W (**schreibbar**, wird an die Quelle weitergegeben) |
| `<gruppe>.WR<n>.InvOutputWatts` | Ausgangsleistung des Geräts in W |
| `<gruppe>.info.Total_Power` | Summe der Ausgangsleistung der Gruppe |
| `<gruppe>.info.Count` | Anzahl Geräte der Gruppe |
| `info.connection` | mindestens ein Gerät liefert aktuelle Daten |

Die Struktur entspricht dem bisherigen Skript, nur das Präfix ändert sich (`0_userdata.0.Wechselrichter` → `ecoflow-gruppen.0`).

## Umstieg vom Skript
1. Skript „Ecoflow Gruppen-Zuordnung“ stoppen (sonst schreiben beide in den Ecoflow-Adapter zurück), danach den Ordner `0_userdata.0.Wechselrichter` löschen, sobald nichts mehr darauf zugreift.
2. Gruppen und Seriennummern in der Tabelle eintragen oder per Import übernehmen (die Gruppennamen des Skripts, z. B. `pv_garten`, `pv_oben`, `akku_wohnung_links`, können unverändert bleiben).
3. Verbraucher auf die neuen IDs umstellen:
   - **Netzlimit:** Basis-Pfad der Wechselrichter-Gruppen `ecoflow-gruppen.0`.
   - **Energiemanagement:** `Quellen.Wechselrichter_Basis` = `ecoflow-gruppen.0`, `Quellen.Wechselrichter_Leistung_DP` = `info.Total_Power`, `PV_Gruppen` und `Akku_Gruppen` mit den eigenen Gruppennamen.
   - **Nulleinspeisung und weitere Skripte:** `0_userdata.0.Wechselrichter.<gruppe>…` → `ecoflow-gruppen.0.<gruppe>…`

## Import / Export der Konfiguration (JSON)
Im Reiter „Import / Export“ der Instanz:
- **Export:** schreibt die aktuelle Konfiguration (auch ungespeicherte Änderungen) als JSON in das Textfeld; mit dem Kopier-Symbol sichern.
- **Import:** JSON einfügen und „JSON aus dem Textfeld importieren“ drücken. Die Werte erscheinen im Formular, danach „Speichern und schließen“ drücken.
- Ungültige Geräte-Zeilen werden übersprungen und genannt. Ungültige globale Werte, defektes JSON oder ein Export einer anderen Adapterart werden abgelehnt.
- Die Instanz muss laufen, weil Export, Import und Geräte-Suche über den Adapter abgewickelt werden.

Format:
```json
{
  "adapter": "ecoflow-gruppen",
  "version": 1,
  "config": {
    "sourceAdapters": "ecoflow-mqtt.5,ecoflow-mqtt.6",
    "staleTimeoutSec": 0,
    "pruneOnStart": true,
    "powerScale": 1,
    "outputScale": 1,
    "maxPowerW": 800,
    "logWrites": false,
    "devices": [
      { "group": "pv_garten", "serial": "HW51ZOH4SF765908" }
    ]
  }
}
```
Fehlende Felder werden beim Import mit Standardwerten ergänzt; der Anzeigename ist nicht Teil der Datei.

## Entwicklung
```bash
npm install
npm test     # Konfiguration, Zuordnung, Summen, Rückweg, Import/Export (ohne ioBroker lauffähig)
```
Struktur: `lib/model.js` (Konfiguration, Datenmodell), `lib/core.js` (Zuordnung, Summen, Rückweg), `lib/configio.js` (JSON-Import/-Export), `main.js` (Adapter). Der Workflow `.github/workflows/test.yml` führt die Tests bei jedem Push auf Node 18, 20 und 22 aus.

## Lizenz
MIT
