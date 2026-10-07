import "./download-export.css";

export function DownloadExport() {
  return (
    <details className="download-export">
      <summary>Download</summary>
      <ul>
        <li>
          <a href="/api/export?format=json" download="trading-journal-backup.json">
            JSON backup
          </a>
        </li>
        <li>
          <a href="/api/export?format=csv" download="trading-journal-trades.csv">
            Raw trade CSV
          </a>
        </li>
      </ul>
    </details>
  );
}
