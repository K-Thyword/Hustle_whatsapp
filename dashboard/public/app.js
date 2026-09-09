const contentEl = document.getElementById("tab-content");
let currentChart = null;

async function api(path, options) {
  const res = await fetch(`/api${path}`, options);
  if (res.status === 401) {
    window.location.href = "/login.html";
    throw new Error("not authenticated");
  }
  if (!res.ok) throw new Error(`Request failed: ${path}`);
  return res.json();
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function statusBadge(status, isOpen) {
  if (status === "cancelled") return `<span class="badge badge-cancelled">cancelled</span>`;
  return `<span class="badge ${isOpen ? "badge-open" : "badge-closed"}">${esc(status)}</span>`;
}

// --- Country detection (Contacts tab grouping) ---
// Phone numbers here are digits-only with no "+" (WhatsApp's own format,
// e.g. "233201516235"). NANP ("+1") is the awkward case — that single
// calling code covers the US, Canada, and over a dozen Caribbean nations,
// distinguished only by the 3-digit area code right after the "1" — so
// it's resolved separately, before falling through to the general
// calling-code table below.
const NANP_AREA_CODES = {
  242: ["BS", "Bahamas"], 246: ["BB", "Barbados"], 264: ["AI", "Anguilla"],
  268: ["AG", "Antigua and Barbuda"], 284: ["VG", "British Virgin Islands"],
  340: ["VI", "US Virgin Islands"], 345: ["KY", "Cayman Islands"],
  441: ["BM", "Bermuda"], 473: ["GD", "Grenada"], 649: ["TC", "Turks and Caicos"],
  658: ["JM", "Jamaica"], 664: ["MS", "Montserrat"], 670: ["MP", "Northern Mariana Islands"],
  671: ["GU", "Guam"], 684: ["AS", "American Samoa"], 721: ["SX", "Sint Maarten"],
  758: ["LC", "Saint Lucia"], 767: ["DM", "Dominica"], 784: ["VC", "Saint Vincent and the Grenadines"],
  787: ["PR", "Puerto Rico"], 809: ["DO", "Dominican Republic"], 829: ["DO", "Dominican Republic"],
  849: ["DO", "Dominican Republic"], 868: ["TT", "Trinidad and Tobago"], 869: ["KN", "Saint Kitts and Nevis"],
  876: ["JM", "Jamaica"], 939: ["PR", "Puerto Rico"],
};

// [calling code, ISO alpha-2, name] — sorted longest-prefix-first below so
// a 3-digit code is always checked before a shorter one that happens to be
// its own prefix (e.g. "233" Ghana before any 2-digit code).
const CALLING_CODES = [
  ["20", "EG", "Egypt"], ["211", "SS", "South Sudan"], ["212", "MA", "Morocco"],
  ["213", "DZ", "Algeria"], ["216", "TN", "Tunisia"], ["218", "LY", "Libya"],
  ["220", "GM", "Gambia"], ["221", "SN", "Senegal"], ["222", "MR", "Mauritania"],
  ["223", "ML", "Mali"], ["224", "GN", "Guinea"], ["225", "CI", "Ivory Coast"],
  ["226", "BF", "Burkina Faso"], ["227", "NE", "Niger"], ["228", "TG", "Togo"],
  ["229", "BJ", "Benin"], ["230", "MU", "Mauritius"], ["231", "LR", "Liberia"],
  ["232", "SL", "Sierra Leone"], ["233", "GH", "Ghana"], ["234", "NG", "Nigeria"],
  ["235", "TD", "Chad"], ["236", "CF", "Central African Republic"], ["237", "CM", "Cameroon"],
  ["238", "CV", "Cape Verde"], ["239", "ST", "Sao Tome and Principe"], ["240", "GQ", "Equatorial Guinea"],
  ["241", "GA", "Gabon"], ["242", "CG", "Republic of Congo"], ["243", "CD", "DR Congo"],
  ["244", "AO", "Angola"], ["245", "GW", "Guinea-Bissau"], ["246", "IO", "British Indian Ocean Territory"],
  ["248", "SC", "Seychelles"], ["249", "SD", "Sudan"], ["250", "RW", "Rwanda"],
  ["251", "ET", "Ethiopia"], ["252", "SO", "Somalia"], ["253", "DJ", "Djibouti"],
  ["254", "KE", "Kenya"], ["255", "TZ", "Tanzania"], ["256", "UG", "Uganda"],
  ["257", "BI", "Burundi"], ["258", "MZ", "Mozambique"], ["260", "ZM", "Zambia"],
  ["261", "MG", "Madagascar"], ["263", "ZW", "Zimbabwe"], ["264", "NA", "Namibia"],
  ["265", "MW", "Malawi"], ["266", "LS", "Lesotho"], ["267", "BW", "Botswana"],
  ["268", "SZ", "Eswatini"], ["269", "KM", "Comoros"], ["27", "ZA", "South Africa"],
  ["290", "SH", "Saint Helena"], ["291", "ER", "Eritrea"],
  ["30", "GR", "Greece"], ["31", "NL", "Netherlands"], ["32", "BE", "Belgium"],
  ["33", "FR", "France"], ["34", "ES", "Spain"], ["350", "GI", "Gibraltar"],
  ["351", "PT", "Portugal"], ["352", "LU", "Luxembourg"], ["353", "IE", "Ireland"],
  ["354", "IS", "Iceland"], ["355", "AL", "Albania"], ["356", "MT", "Malta"],
  ["357", "CY", "Cyprus"], ["358", "FI", "Finland"], ["359", "BG", "Bulgaria"],
  ["36", "HU", "Hungary"], ["370", "LT", "Lithuania"], ["371", "LV", "Latvia"],
  ["372", "EE", "Estonia"], ["373", "MD", "Moldova"], ["374", "AM", "Armenia"],
  ["375", "BY", "Belarus"], ["376", "AD", "Andorra"], ["377", "MC", "Monaco"],
  ["378", "SM", "San Marino"], ["380", "UA", "Ukraine"], ["381", "RS", "Serbia"],
  ["382", "ME", "Montenegro"], ["383", "XK", "Kosovo"], ["385", "HR", "Croatia"],
  ["386", "SI", "Slovenia"], ["387", "BA", "Bosnia and Herzegovina"], ["389", "MK", "North Macedonia"],
  ["39", "IT", "Italy"], ["40", "RO", "Romania"], ["41", "CH", "Switzerland"],
  ["420", "CZ", "Czechia"], ["421", "SK", "Slovakia"], ["423", "LI", "Liechtenstein"],
  ["43", "AT", "Austria"], ["44", "GB", "United Kingdom"], ["45", "DK", "Denmark"],
  ["46", "SE", "Sweden"], ["47", "NO", "Norway"], ["48", "PL", "Poland"],
  ["49", "DE", "Germany"], ["500", "FK", "Falkland Islands"], ["501", "BZ", "Belize"],
  ["502", "GT", "Guatemala"], ["503", "SV", "El Salvador"], ["504", "HN", "Honduras"],
  ["505", "NI", "Nicaragua"], ["506", "CR", "Costa Rica"], ["507", "PA", "Panama"],
  ["508", "PM", "Saint Pierre and Miquelon"], ["509", "HT", "Haiti"], ["51", "PE", "Peru"],
  ["52", "MX", "Mexico"], ["53", "CU", "Cuba"], ["54", "AR", "Argentina"],
  ["55", "BR", "Brazil"], ["56", "CL", "Chile"], ["57", "CO", "Colombia"],
  ["58", "VE", "Venezuela"], ["590", "GP", "Guadeloupe"], ["591", "BO", "Bolivia"],
  ["592", "GY", "Guyana"], ["593", "EC", "Ecuador"], ["594", "GF", "French Guiana"],
  ["595", "PY", "Paraguay"], ["596", "MQ", "Martinique"], ["597", "SR", "Suriname"],
  ["598", "UY", "Uruguay"], ["599", "CW", "Curacao"], ["60", "MY", "Malaysia"],
  ["61", "AU", "Australia"], ["62", "ID", "Indonesia"], ["63", "PH", "Philippines"],
  ["64", "NZ", "New Zealand"], ["65", "SG", "Singapore"], ["66", "TH", "Thailand"],
  ["670", "TL", "East Timor"], ["673", "BN", "Brunei"], ["674", "NR", "Nauru"],
  ["675", "PG", "Papua New Guinea"], ["676", "TO", "Tonga"], ["677", "SB", "Solomon Islands"],
  ["678", "VU", "Vanuatu"], ["679", "FJ", "Fiji"], ["680", "PW", "Palau"],
  ["681", "WF", "Wallis and Futuna"], ["682", "CK", "Cook Islands"], ["683", "NU", "Niue"],
  ["685", "WS", "Samoa"], ["686", "KI", "Kiribati"], ["687", "NC", "New Caledonia"],
  ["688", "TV", "Tuvalu"], ["689", "PF", "French Polynesia"], ["690", "TK", "Tokelau"],
  ["691", "FM", "Micronesia"], ["692", "MH", "Marshall Islands"], ["81", "JP", "Japan"],
  ["82", "KR", "South Korea"], ["84", "VN", "Vietnam"], ["850", "KP", "North Korea"],
  ["852", "HK", "Hong Kong"], ["853", "MO", "Macau"], ["855", "KH", "Cambodia"],
  ["856", "LA", "Laos"], ["86", "CN", "China"], ["880", "BD", "Bangladesh"],
  ["886", "TW", "Taiwan"], ["90", "TR", "Turkey"], ["91", "IN", "India"],
  ["92", "PK", "Pakistan"], ["93", "AF", "Afghanistan"], ["94", "LK", "Sri Lanka"],
  ["95", "MM", "Myanmar"], ["960", "MV", "Maldives"], ["961", "LB", "Lebanon"],
  ["962", "JO", "Jordan"], ["963", "SY", "Syria"], ["964", "IQ", "Iraq"],
  ["965", "KW", "Kuwait"], ["966", "SA", "Saudi Arabia"], ["967", "YE", "Yemen"],
  ["968", "OM", "Oman"], ["970", "PS", "Palestine"], ["971", "AE", "United Arab Emirates"],
  ["972", "IL", "Israel"], ["973", "BH", "Bahrain"], ["974", "QA", "Qatar"],
  ["975", "BT", "Bhutan"], ["976", "MN", "Mongolia"], ["977", "NP", "Nepal"],
  ["98", "IR", "Iran"], ["992", "TJ", "Tajikistan"], ["993", "TM", "Turkmenistan"],
  ["994", "AZ", "Azerbaijan"], ["995", "GE", "Georgia"], ["996", "KG", "Kyrgyzstan"],
  ["998", "UZ", "Uzbekistan"], ["7", "RU", "Russia/Kazakhstan"],
];
CALLING_CODES.sort((a, b) => b[0].length - a[0].length);

// Regional-indicator flag emoji, computed from an ISO alpha-2 code rather
// than hand-listed per country — two Unicode codepoints offset from the
// letters, so it stays correct for every entry above with zero upkeep.
function flagEmoji(alpha2) {
  if (!alpha2 || alpha2.length !== 2) return "🌍";
  return String.fromCodePoint(...[...alpha2.toUpperCase()].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65)));
}

// Returns { alpha2, name } for a digits-only phone number — "Unknown" (no
// flag) if nothing in the table matches, rather than guessing.
function detectCountry(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("1") && digits.length >= 4) {
    const areaCode = digits.slice(1, 4);
    const nanp = NANP_AREA_CODES[areaCode];
    if (nanp) return { alpha2: nanp[0], name: nanp[1] };
    return { alpha2: "US", name: "USA/Canada" };
  }
  for (const [code, alpha2, name] of CALLING_CODES) {
    if (digits.startsWith(code)) return { alpha2, name };
  }
  return { alpha2: "", name: "Unknown" };
}

// --- Export: CSV / PDF, shared by every tab that offers a download ---

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function toCsvValue(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(filename, headers, rows) {
  const lines = [headers.map(toCsvValue).join(","), ...rows.map((row) => row.map(toCsvValue).join(","))];
  downloadBlob(filename, new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" }));
}

// Table PDF (Contacts, Agents, Requests, chat exports) — jsPDF + the
// autoTable plugin, both loaded from cdnjs as plain globals (no build
// step here, so no import/registration step needed beyond the <script>
// tags in index.html).
function exportPdf(filename, title, headers, rows) {
  if (!window.jspdf || typeof window.jspdf.jsPDF !== "function") {
    alert("PDF export isn't available right now — refresh the page and try again.");
    return;
  }
  const doc = new window.jspdf.jsPDF();
  doc.setFontSize(14);
  doc.text(title, 14, 15);
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(`Exported ${new Date().toLocaleString()}`, 14, 21);
  doc.setTextColor(0);
  if (typeof doc.autoTable !== "function") {
    alert("PDF export isn't available right now — refresh the page and try again.");
    return;
  }
  doc.autoTable({ startY: 26, head: [headers], body: rows, styles: { fontSize: 8 }, headStyles: { fillColor: [26, 107, 47] } });
  doc.save(filename);
}

// Freeform-text PDF (Reports digest — a paragraph, not a table).
function exportTextPdf(filename, title, bodyText) {
  if (!window.jspdf || typeof window.jspdf.jsPDF !== "function") {
    alert("PDF export isn't available right now — refresh the page and try again.");
    return;
  }
  const doc = new window.jspdf.jsPDF();
  doc.setFontSize(14);
  doc.text(title, 14, 15);
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(`Exported ${new Date().toLocaleString()}`, 14, 21);
  doc.setTextColor(0);
  doc.setFontSize(11);
  doc.text(doc.splitTextToSize(bodyText || "(empty)", 180), 14, 30);
  doc.save(filename);
}

// --- Reusable sortable / searchable / exportable data table ---
// Powers Contacts and Agents (Requests stays hand-rolled since it also has
// expandable timeline rows and server-side status/service filters). One
// module owns search-filtering, column-sort-on-click, and CSV/PDF export
// against whatever's currently visible, so those three behaviors are
// written once instead of separately per tab — the deletion test: without
// this, each tab would carry its own copy of sort/filter/export wiring
// that could quietly drift out of sync with the others over time.
function renderDataTable(containerEl, opts) {
  const { columns, rows, searchPlaceholder, exportFilenameBase, pdfTitle, emptyText, defaultSortKey } = opts;
  let sortKey = defaultSortKey || columns[0].key;
  let sortDir = "desc";
  let query = "";

  containerEl.innerHTML = `
    <div class="filters">
      ${searchPlaceholder ? `<input type="search" class="dt-search" placeholder="${esc(searchPlaceholder)}" style="flex:1" />` : ""}
      <div class="dt-export" style="display:flex; gap:8px"></div>
    </div>
    <div class="dt-table"></div>`;

  const searchInput = containerEl.querySelector(".dt-search");
  const exportEl = containerEl.querySelector(".dt-export");
  const tableWrap = containerEl.querySelector(".dt-table");

  function visibleRows() {
    let out = rows;
    if (query) {
      const q = query.toLowerCase();
      out = out.filter((r) => columns.some((c) => String(r[c.key] ?? "").toLowerCase().includes(q)));
    }
    return [...out].sort((a, b) => {
      const av = a[sortKey],
        bv = b[sortKey];
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av ?? "").localeCompare(String(bv ?? ""));
      return sortDir === "asc" ? cmp : -cmp;
    });
  }

  function render() {
    const data = visibleRows();
    if (!data.length) {
      tableWrap.innerHTML = `<p class="muted">${esc(emptyText || "No matching rows.")}</p>`;
    } else {
      tableWrap.innerHTML = `<div class="table-wrap"><table>
        <thead><tr>${columns
          .map((c) => `<th class="dt-th ${sortKey === c.key ? `sorted-${sortDir}` : ""}" data-key="${c.key}">${esc(c.label)}</th>`)
          .join("")}</tr></thead>
        <tbody>${data
          .map((r) => `<tr>${columns.map((c) => `<td>${c.format ? c.format(r[c.key], r) : esc(r[c.key])}</td>`).join("")}</tr>`)
          .join("")}</tbody>
      </table></div>
      <p class="muted" style="margin-top:10px">${data.length} row${data.length === 1 ? "" : "s"}.</p>`;

      tableWrap.querySelectorAll(".dt-th").forEach((th) =>
        th.addEventListener("click", () => {
          const key = th.dataset.key;
          if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
          else {
            sortKey = key;
            sortDir = "asc";
          }
          render();
        })
      );
    }

    // Export always reflects the current search + sort, not the full
    // unfiltered dataset — "what you're looking at" is what gets downloaded.
    exportEl.innerHTML = `<button class="refresh dt-csv">Export CSV</button><button class="refresh dt-pdf">Export PDF</button>`;
    exportEl.querySelector(".dt-csv").addEventListener("click", () => {
      exportCsv(`${exportFilenameBase}.csv`, columns.map((c) => c.label), data.map((r) => columns.map((c) => r[c.key] ?? "")));
    });
    exportEl.querySelector(".dt-pdf").addEventListener("click", () => {
      exportPdf(`${exportFilenameBase}.pdf`, pdfTitle, columns.map((c) => c.label), data.map((r) => columns.map((c) => r[c.key] ?? "")));
    });
  }

  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      query = e.target.value.trim();
      render();
    });
  }
  render();
}

// --- Tab: Overview ---
async function renderOverview() {
  contentEl.innerHTML = `<h1>Overview</h1><p class="muted">A snapshot of recent activity.</p>
    <div class="filters">
      <select id="overviewDays">
        <option value="1">Today</option>
        <option value="7" selected>Last 7 days</option>
        <option value="30">Last 30 days</option>
      </select>
    </div>
    <div class="kpi-row" id="kpiRow"></div>
    <div class="chart-wrap"><canvas id="serviceChart" height="200"></canvas></div>`;

  const load = async () => {
    const days = document.getElementById("overviewDays").value;
    const data = await api(`/overview?days=${days}`);
    document.getElementById("kpiRow").innerHTML = `
      <div class="kpi-card"><div class="value">${data.submitted}</div><div class="label">New requests (${esc(data.windowLabel)})</div></div>
      <div class="kpi-card"><div class="value">${data.completed}</div><div class="label">Completed</div></div>
      <div class="kpi-card"><div class="value">${data.cancelled}</div><div class="label">Cancelled</div></div>
      <div class="kpi-card"><div class="value">${data.open}</div><div class="label">Open right now (all-time)</div></div>
      <div class="kpi-card"><div class="value">${data.alerts}</div><div class="label">Delivery alerts</div></div>
      <div class="kpi-card"><div class="value">${data.strugglingConversations}</div><div class="label">Customers who seemed stuck</div></div>`;

    if (currentChart) currentChart.destroy();
    const ctx = document.getElementById("serviceChart");
    const labels = Object.keys(data.byService);
    currentChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: labels.length ? labels : ["No requests yet"],
        datasets: [{ label: "Requests by service", data: labels.length ? Object.values(data.byService) : [0], backgroundColor: "#1a6b2f" }],
      },
      options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } },
    });
  };
  document.getElementById("overviewDays").addEventListener("change", load);
  load();
}

// --- Tab: Requests ---
// Keeps its own hand-rolled table (rather than renderDataTable) because it
// has two things the shared component doesn't: server-side status/service
// filters, and per-row expandable timeline sub-rows.
const REQUEST_SORT_COLUMNS = [
  { key: "requestId", label: "Reference" },
  { key: "serviceType", label: "Service" },
  { key: "location", label: "Location" },
  { key: "status", label: "Status" },
  { key: "claimedByName", label: "Claimed by" },
  { key: "submittedAt", label: "Submitted" },
  { key: "lastUpdated", label: "Updated" },
];

async function renderRequests() {
  contentEl.innerHTML = `<h1>Requests</h1><p class="muted">Every request's current status, grouped from the event log. Click a column to sort.</p>
    <div class="filters">
      <select id="statusFilter">
        <option value="">All statuses</option>
        <option value="open">Open only</option>
        <option value="submitted">Submitted</option>
        <option value="claimed">Claimed</option>
        <option value="quoted">Quoted</option>
        <option value="matched">Matched</option>
        <option value="confirmed">Confirmed</option>
        <option value="completed">Completed</option>
        <option value="reviewed">Reviewed</option>
        <option value="cancelled">Cancelled</option>
      </select>
      <select id="serviceFilter"><option value="">All services</option></select>
      <div style="display:flex; gap:8px; margin-left:auto">
        <button class="refresh" id="reqExportCsv">Export CSV</button>
        <button class="refresh" id="reqExportPdf">Export PDF</button>
      </div>
    </div>
    <div id="requestsTable"></div>`;

  let sortKey = "lastUpdated";
  let sortDir = "desc";
  let rows = [];
  let serviceOptionsPopulated = false;

  function sortedRows() {
    return [...rows].sort((a, b) => {
      const av = a[sortKey] ?? "",
        bv = b[sortKey] ?? "";
      const cmp = String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
  }

  const load = async () => {
    const status = document.getElementById("statusFilter").value;
    const service = document.getElementById("serviceFilter").value;
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (service) params.set("service", service);
    rows = await api(`/requests${params.toString() ? `?${params}` : ""}`);

    if (!serviceOptionsPopulated) {
      // Populated once, from whatever the first (typically unfiltered) load
      // returns — good enough without a dedicated "distinct services"
      // endpoint, since serviceType values are a small, stable set.
      const services = [...new Set(rows.map((r) => r.serviceType).filter(Boolean))].sort();
      const sel = document.getElementById("serviceFilter");
      for (const s of services) sel.insertAdjacentHTML("beforeend", `<option value="${esc(s)}">${esc(s)}</option>`);
      serviceOptionsPopulated = true;
    }

    renderTable();
  };

  function renderTable() {
    const data = sortedRows();
    if (!data.length) {
      document.getElementById("requestsTable").innerHTML = `<p class="muted">No requests found.</p>`;
      return;
    }
    document.getElementById("requestsTable").innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th></th>${REQUEST_SORT_COLUMNS.map(
        (c) => `<th class="dt-th ${sortKey === c.key ? `sorted-${sortDir}` : ""}" data-key="${c.key}">${esc(c.label)}</th>`
      ).join("")}</tr></thead>
      <tbody>${data
        .map(
          (r, i) => `<tr class="req-row" data-idx="${i}" style="cursor:pointer">
            <td class="expand-arrow">▸</td>
            <td>${esc(r.requestId)}</td>
            <td>${esc(r.serviceType)}</td>
            <td>${esc(r.location)}</td>
            <td>${statusBadge(r.status, r.isOpen)}</td>
            <td>${esc(r.claimedByName ?? "—")}</td>
            <td>${fmtTime(r.submittedAt)}</td>
            <td>${fmtTime(r.lastUpdated)}</td>
          </tr>
          <tr class="req-timeline hidden" data-timeline-for="${i}"><td colspan="8"></td></tr>`
        )
        .join("")}</tbody></table></div>
      <p class="muted" style="margin-top:10px">${data.length} request${data.length === 1 ? "" : "s"}.</p>`;

    document.querySelectorAll(".dt-th").forEach((th) =>
      th.addEventListener("click", () => {
        const key = th.dataset.key;
        if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
        else {
          sortKey = key;
          sortDir = "asc";
        }
        renderTable();
      })
    );

    document.querySelectorAll(".req-row").forEach((rowEl) => {
      rowEl.addEventListener("click", () => {
        const idx = rowEl.dataset.idx;
        const timelineRow = document.querySelector(`[data-timeline-for="${idx}"]`);
        const arrow = rowEl.querySelector(".expand-arrow");
        const isHidden = timelineRow.classList.contains("hidden");
        if (isHidden) {
          const r = data[idx];
          const cell = timelineRow.querySelector("td");
          cell.innerHTML = r.timeline.length
            ? `<div class="timeline">${r.timeline
                .map((t) => `<div class="timeline-item"><span class="badge badge-open">${esc(t.event)}</span> ${fmtTime(t.timestamp)}${t.detail ? ` — <span class="muted">${esc(t.detail)}</span>` : ""}</div>`)
                .join("")}</div>`
            : `<span class="muted">No timeline events.</span>`;
        }
        timelineRow.classList.toggle("hidden");
        arrow.textContent = isHidden ? "▾" : "▸";
      });
    });
  }

  document.getElementById("statusFilter").addEventListener("change", load);
  document.getElementById("serviceFilter").addEventListener("change", load);
  document.getElementById("reqExportCsv").addEventListener("click", () => {
    const data = sortedRows();
    exportCsv(
      "hustleapp-requests.csv",
      REQUEST_SORT_COLUMNS.map((c) => c.label),
      data.map((r) => REQUEST_SORT_COLUMNS.map((c) => r[c.key] ?? ""))
    );
  });
  document.getElementById("reqExportPdf").addEventListener("click", () => {
    const data = sortedRows();
    exportPdf(
      "hustleapp-requests.pdf",
      "Hustleapp Requests",
      REQUEST_SORT_COLUMNS.map((c) => c.label),
      data.map((r) => REQUEST_SORT_COLUMNS.map((c) => r[c.key] ?? ""))
    );
  });
  load();
}

// --- Tab: Alerts ---
async function renderAlerts() {
  contentEl.innerHTML = `<h1>Alerts</h1><p class="muted">Notifications that never actually reached an agent or customer — window closed, template also failed.</p><div id="alertsTable"></div>`;
  const rows = await api("/alerts");
  if (!rows.length) {
    document.getElementById("alertsTable").innerHTML = `<p class="muted">No alerts logged. 🎉</p>`;
    return;
  }
  document.getElementById("alertsTable").innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>When</th><th>Message</th></tr></thead>
    <tbody>${rows.map((a) => `<tr><td>${fmtTime(a.timestamp)}</td><td>${esc(a.message)}</td></tr>`).join("")}</tbody></table></div>`;
}

// --- Tab: Chats ---
async function renderChats() {
  contentEl.innerHTML = `<h1>Chats</h1><p class="muted">Browse full conversations, or search across all of them.</p>
    <div class="filters">
      <input type="search" id="chatSearch" placeholder="Search messages or phone number..." style="flex:1" />
      <button class="refresh" id="exportAllCsv">Export all chats (CSV)</button>
      <button class="refresh" id="exportAllPdf">Export all chats (PDF)</button>
    </div>
    <div class="two-col">
      <div class="card conv-list" id="convList"></div>
      <div class="card thread" id="thread"><p class="muted">Select a conversation.</p></div>
    </div>`;

  const convList = document.getElementById("convList");
  const thread = document.getElementById("thread");
  // unreadCount now comes straight from the server (see api.ts's
  // /conversations, backed by readState.ts) — this is just a local cache of
  // the last response, kept so refreshUnreadBadges() can re-render a badge
  // instantly after marking a phone seen, without a full re-fetch.
  let unreadCounts = {};
  let allLines = [];

  function unreadBadge(phone) {
    const n = unreadCounts[phone];
    return n ? `<span class="unread-badge">${n}</span>` : "";
  }

  document.getElementById("exportAllCsv").addEventListener("click", () => {
    if (!allLines.length) return alert("Still loading conversations — try again in a second.");
    exportCsv(
      "hustleapp-all-chats.csv",
      ["Phone", "Timestamp", "Direction", "Message"],
      allLines.map((l) => [l.phone, l.timestamp, l.direction, l.text])
    );
  });
  document.getElementById("exportAllPdf").addEventListener("click", () => {
    if (!allLines.length) return alert("Still loading conversations — try again in a second.");
    exportPdf(
      "hustleapp-all-chats.pdf",
      "Hustleapp — All Conversations",
      ["Phone", "Timestamp", "Direction", "Message"],
      allLines.map((l) => [l.phone, l.timestamp, l.direction, l.text])
    );
  });

  async function loadConversations() {
    const [convs, lines] = await Promise.all([api("/conversations"), api("/transcripts")]);
    allLines = lines;
    unreadCounts = {};
    for (const c of convs) if (c.unreadCount) unreadCounts[c.phone] = c.unreadCount;
    if (!convs.length) {
      convList.innerHTML = `<p class="muted" style="padding:12px">No conversations logged yet.</p>`;
      return;
    }
    convList.innerHTML = convs
      .map(
        (c) => `<div class="conv-item" data-phone="${esc(c.phone)}">
          <div class="conv-phone">${esc(c.phone)} ${unreadBadge(c.phone)}</div>
          <div class="conv-preview">${esc(c.lastMessage)}</div>
          <div class="msg-time">${fmtTime(c.lastTimestamp)} · ${c.messageCount} msgs${c.unreadCount ? ` · ${c.unreadCount} new` : ""}</div>
        </div>`
      )
      .join("");
    convList.querySelectorAll(".conv-item").forEach((el) =>
      el.addEventListener("click", () => {
        convList.querySelectorAll(".conv-item").forEach((x) => x.classList.remove("active"));
        el.classList.add("active");
        loadThread(el.dataset.phone);
      })
    );
  }

  // Re-renders just the badges/highlight against the in-memory unreadCounts
  // — used right after marking a phone seen, so the count clears instantly
  // without a full re-fetch of conversations + transcripts.
  function refreshUnreadBadges() {
    convList.querySelectorAll(".conv-item").forEach((el) => {
      const phone = el.dataset.phone;
      const phoneEl = el.querySelector(".conv-phone");
      const existingBadge = phoneEl.querySelector(".unread-badge");
      if (existingBadge) existingBadge.remove();
      const badge = unreadBadge(phone);
      if (badge) phoneEl.insertAdjacentHTML("beforeend", ` ${badge}`);
    });
  }

  async function loadThread(phone) {
    thread.innerHTML = `<p class="muted">Loading…</p>`;
    const lines = await api(`/conversations/${encodeURIComponent(phone)}`);
    const exportBar = `<div style="display:flex; justify-content:flex-end; gap:8px; margin-bottom:10px">
      <button class="refresh" id="threadExportCsv">Export CSV</button>
      <button class="refresh" id="threadExportPdf">Export PDF</button>
    </div>`;
    const messages = lines
      .map(
        (l) => `<div class="msg-row ${l.direction}">
          <div>
            <div class="msg ${l.direction}">${esc(l.text)}</div>
            <div class="msg-time" style="text-align:${l.direction === "bot" ? "right" : "left"}">${fmtTime(l.timestamp)}</div>
          </div>
        </div>`
      )
      .join("");
    thread.innerHTML = exportBar + messages;
    document.getElementById("threadExportCsv").addEventListener("click", () => {
      exportCsv(`hustleapp-chat-${phone}.csv`, ["Timestamp", "Direction", "Message"], lines.map((l) => [l.timestamp, l.direction, l.text]));
    });
    document.getElementById("threadExportPdf").addEventListener("click", () => {
      exportPdf(
        `hustleapp-chat-${phone}.pdf`,
        `Hustleapp — Conversation with ${phone}`,
        ["Timestamp", "Direction", "Message"],
        lines.map((l) => [l.timestamp, l.direction, l.text])
      );
    });
    // Fire-and-forget: don't block rendering the thread on this, and a
    // failure here shouldn't stop the agent from reading messages they
    // already fetched — worst case the badge just doesn't clear this time.
    api(`/conversations/${encodeURIComponent(phone)}/seen`, { method: "POST" }).catch((err) =>
      console.error("Failed to mark conversation seen:", err)
    );
    delete unreadCounts[phone];
    refreshUnreadBadges();
  }

  let searchTimer;
  document.getElementById("chatSearch").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(async () => {
      if (!q) return loadConversations();
      const results = await api(`/transcripts/search?q=${encodeURIComponent(q)}`);
      convList.innerHTML = results.length
        ? results
            .map(
              (l) => `<div class="conv-item" data-phone="${esc(l.phone)}">
                <div class="conv-phone">${esc(l.phone)}</div>
                <div class="conv-preview">${esc(l.text)}</div>
                <div class="msg-time">${fmtTime(l.timestamp)}</div>
              </div>`
            )
            .join("")
        : `<p class="muted" style="padding:12px">No matches.</p>`;
      convList.querySelectorAll(".conv-item").forEach((el) =>
        el.addEventListener("click", () => loadThread(el.dataset.phone))
      );
    }, 300);
  });

  loadConversations();
}

// --- Tab: Contacts ---
// Every unique phone number that has ever messaged the bot, one row each —
// reuses /api/conversations, which is already grouped/deduped by phone (a
// repeat contact days later lands back in the same entry, it never creates
// a second one), just sorted and displayed differently than the Chats list.
// Every unique number that has messaged the bot, grouped by country —
// Ghana first, Bahamas second (the two priority markets), then every other
// detected country alphabetically, each still clearly labeled rather than
// lumped into one catch-all. Reuses /api/conversations, which already
// carries unreadCount (readState.ts) alongside the existing total
// messageCount, so both a "total" and a "new" figure show per contact.
const CONTACT_COUNTRY_PRIORITY = ["Ghana", "Bahamas"];

async function renderContacts() {
  contentEl.innerHTML = `<h1>Contacts</h1><p class="muted">Every unique number that has messaged the bot, grouped by country.</p>
    <div class="filters">
      <input type="search" id="contactSearch" placeholder="Search phone number..." style="flex:1" />
      <button class="refresh" id="contactsExportCsv">Export CSV</button>
      <button class="refresh" id="contactsExportPdf">Export PDF</button>
    </div>
    <div id="contactsGroups"></div>`;

  const convs = await api("/conversations");
  const withCountry = convs.map((c) => ({ ...c, country: detectCountry(c.phone) }));
  const groupsEl = document.getElementById("contactsGroups");

  function contactRow(c) {
    return `<tr>
      <td>${esc(c.phone)}</td>
      <td>${fmtTime(c.firstTimestamp)}</td>
      <td>${fmtTime(c.lastTimestamp)}</td>
      <td>${c.messageCount}</td>
      <td>${c.unreadCount ? `<span class="unread-badge">${c.unreadCount}</span>` : "—"}</td>
    </tr>`;
  }

  function render() {
    const q = document.getElementById("contactSearch").value.trim().toLowerCase();
    const filtered = q ? withCountry.filter((c) => c.phone.toLowerCase().includes(q)) : withCountry;

    if (!filtered.length) {
      groupsEl.innerHTML = `<p class="muted">No contacts match.</p>`;
      bindExport([]);
      return;
    }

    const byCountry = new Map();
    for (const c of filtered) {
      if (!byCountry.has(c.country.name)) byCountry.set(c.country.name, []);
      byCountry.get(c.country.name).push(c);
    }

    const otherNames = [...byCountry.keys()]
      .filter((n) => !CONTACT_COUNTRY_PRIORITY.includes(n))
      .sort((a, b) => a.localeCompare(b));
    const orderedNames = [...CONTACT_COUNTRY_PRIORITY.filter((n) => byCountry.has(n)), ...otherNames];

    groupsEl.innerHTML = orderedNames
      .map((name) => {
        const rows = byCountry.get(name).sort((a, b) => (a.lastTimestamp < b.lastTimestamp ? 1 : -1));
        const flag = rows[0].country.alpha2 ? flagEmoji(rows[0].country.alpha2) : "🌍";
        return `<div class="card" style="margin-bottom:16px">
          <h2 style="margin-top:0">${flag} ${esc(name)} <span class="muted" style="font-weight:400">(${rows.length})</span></h2>
          <div class="table-wrap"><table>
            <thead><tr><th>Phone</th><th>First contacted</th><th>Last contacted</th><th>Messages</th><th>New</th></tr></thead>
            <tbody>${rows.map(contactRow).join("")}</tbody>
          </table></div>
        </div>`;
      })
      .join("");

    bindExport(orderedNames.flatMap((name) => byCountry.get(name)));
  }

  function bindExport(orderedRows) {
    document.getElementById("contactsExportCsv").onclick = () => {
      exportCsv(
        "hustleapp-contacts.csv",
        ["Phone", "Country", "First contacted", "Last contacted", "Messages", "New messages"],
        orderedRows.map((c) => [c.phone, c.country.name, c.firstTimestamp, c.lastTimestamp, c.messageCount, c.unreadCount])
      );
    };
    document.getElementById("contactsExportPdf").onclick = () => {
      exportPdf(
        "hustleapp-contacts.pdf",
        "Hustleapp Contacts",
        ["Phone", "Country", "First contacted", "Last contacted", "Messages", "New messages"],
        orderedRows.map((c) => [c.phone, c.country.name, c.firstTimestamp, c.lastTimestamp, c.messageCount, c.unreadCount])
      );
    };
  }

  document.getElementById("contactSearch").addEventListener("input", render);
  render();
}

// --- Tab: Agents ---
async function renderAgents() {
  contentEl.innerHTML = `<h1>Agents</h1><p class="muted">Workload derived from who's claimed each request. Click a column to sort, or search below.</p><div id="agentsDT"></div>`;
  const rows = await api("/agents");
  renderDataTable(document.getElementById("agentsDT"), {
    columns: [
      { key: "name", label: "Agent" },
      { key: "claimed", label: "Total claimed" },
      { key: "open", label: "Open" },
      { key: "completed", label: "Completed" },
    ],
    rows,
    searchPlaceholder: "Search agent name...",
    exportFilenameBase: "hustleapp-agents",
    pdfTitle: "Hustleapp Agent Workload",
    emptyText: "No claims logged yet.",
    defaultSortKey: "claimed",
  });
}

// --- Tab: Reports ---
async function renderReports() {
  contentEl.innerHTML = `<h1>Reports</h1><p class="muted">Sent automatically to agents over WhatsApp every Monday at 8am — also viewable here anytime.</p>
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px">
        <h2 style="margin:0">This week</h2>
        <div style="display:flex; gap:8px">
          <button class="refresh" id="digestExportCsv">Export CSV</button>
          <button class="refresh" id="digestExportPdf">Export PDF</button>
          <button class="refresh" id="regenBtn">Regenerate</button>
        </div>
      </div>
      <div class="digest-box" id="digestBox">Loading…</div>
    </div>
    <div class="card" style="margin-top:16px" id="sendCard"></div>`;

  let digestText = "";

  const load = async () => {
    document.getElementById("digestBox").textContent = "Loading…";
    const { text, aiGenerated } = await api("/digest");
    digestText = text;
    document.getElementById("digestBox").innerHTML = `${esc(text)}${
      aiGenerated ? "" : `<div class="muted" style="margin-top:10px">(Computed summary — set ANTHROPIC_API_KEY on this service for an AI-written version.)</div>`
    }`;
  };
  document.getElementById("regenBtn").addEventListener("click", load);
  document.getElementById("digestExportCsv").addEventListener("click", () => {
    // One row per line of the digest — it's freeform prose, not a table, so
    // this is meant for pasting into a spreadsheet rather than analysis.
    exportCsv("hustleapp-weekly-digest.csv", ["Weekly digest"], digestText.split("\n").map((line) => [line]));
  });
  document.getElementById("digestExportPdf").addEventListener("click", () => {
    exportTextPdf("hustleapp-weekly-digest.pdf", "Hustleapp Weekly Digest", digestText);
  });

  const { configured } = await api("/digest/whatsapp-status");
  const sendCard = document.getElementById("sendCard");
  if (!configured) {
    sendCard.innerHTML = `<h2 style="margin-top:0">WhatsApp delivery</h2>
      <p class="muted">Not set up yet on this service — add WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, and AGENT_NOTIFY_NUMBERS to send this automatically. See dashboard/README.md.</p>`;
  } else {
    sendCard.innerHTML = `<h2 style="margin-top:0">WhatsApp delivery</h2>
      <p class="muted">Configured — sends automatically Monday 8am. Send this week's digest right now to confirm it works:</p>
      <button class="refresh" id="sendNowBtn">Send now</button>
      <span id="sendStatus" class="muted" style="margin-left:10px"></span>`;
    document.getElementById("sendNowBtn").addEventListener("click", async (e) => {
      e.target.disabled = true;
      document.getElementById("sendStatus").textContent = "Sending…";
      const result = await (await fetch("/api/digest/send-now", { method: "POST" })).json();
      document.getElementById("sendStatus").textContent = `Sent to ${result.sent} agent(s)${result.failed ? `, ${result.failed} failed` : ""}.`;
      e.target.disabled = false;
    });
  }

  load();
}

const tabs = {
  overview: renderOverview,
  requests: renderRequests,
  alerts: renderAlerts,
  chats: renderChats,
  contacts: renderContacts,
  agents: renderAgents,
  reports: renderReports,
};

// Chats and Reports both hold in-progress state a background refresh would
// clobber (a selected conversation mid-read, a "Send now" button click) —
// only the plain data-table tabs auto-refresh.
const AUTO_REFRESH_TABS = new Set(["overview", "requests", "alerts", "contacts", "agents"]);
let currentTab = "overview";
let lastRefreshAt = Date.now();

function switchTab(name) {
  currentTab = name;
  lastRefreshAt = Date.now();
  tabs[name]();
}

document.querySelectorAll(".nav-item[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item[data-tab]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    switchTab(btn.dataset.tab);
  });
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login.html";
});

setInterval(() => {
  const el = document.getElementById("lastUpdated");
  if (!el) return;
  const secs = Math.round((Date.now() - lastRefreshAt) / 1000);
  el.textContent = secs < 5 ? "Updated just now" : `Updated ${secs}s ago`;
}, 1000);

setInterval(() => {
  if (AUTO_REFRESH_TABS.has(currentTab)) {
    lastRefreshAt = Date.now();
    tabs[currentTab]();
  }
}, 45000);

(async function init() {
  try {
    const status = await api("/status");
    if (!status.sheetsConfigured) document.getElementById("sheetsWarning").classList.remove("hidden");
  } catch {
    // /api/status itself redirects to login on 401, nothing else to do here
    return;
  }
  switchTab("overview");
})();
