import React, { useState, useMemo, useEffect, useRef } from "react";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Cell } from "recharts";
import {
  Wrench, ShieldCheck, Fuel, ClipboardList, TrendingDown, Plus, X,
  CalendarClock, ChevronRight, ArrowLeft, Car, Trash2, FileText, Download,
  Bell, BellRing, BellOff, Check, Loader2, AlertCircle, Receipt, Save, MapPin, PoundSterling, Pencil, Palette,
} from "lucide-react";

// ---------- helpers ----------
const fmtGBP = (n) => `£${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const daysUntil = (dateStr) => {
  const d = new Date(dateStr);
  const now = new Date();
  return Math.ceil((d - now) / (1000 * 60 * 60 * 24));
};
const fmtDate = (dateStr) =>
  new Date(dateStr).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const fmtBytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};
// Opening large base64 data: URLs in a new tab is unreliable on mobile Safari
// (often shows a blank page). Converting to a Blob object URL and navigating
// the current tab is much more reliable for viewing PDFs/images on phones.
function openDocument(dataUrl) {
  try {
    const [header, base64] = dataUrl.split(",");
    const mimeMatch = header.match(/data:(.*?);base64/);
    const mime = mimeMatch ? mimeMatch[1] : "application/octet-stream";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    const blobUrl = URL.createObjectURL(blob);
    window.open(blobUrl, "_blank") || (window.location.href = blobUrl);
  } catch (e) {
    window.location.href = dataUrl;
  }
}

// ---- Web Push helper: converts the VAPID public key into the format pushManager.subscribe expects ----
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

// ---- persistent storage: uses the artifact's window.storage when available,
// falls back to localStorage when this app is running as its own hosted site ----
async function storageGet(key) {
  if (typeof window !== "undefined" && window.storage && typeof window.storage.get === "function") {
    try {
      const res = await window.storage.get(key, false);
      return res ? JSON.parse(res.value) : null;
    } catch (e) {
      return null; // nothing saved yet under this key
    }
  }
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      const raw = window.localStorage.getItem(`peags:${key}`);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  return null;
}
async function storageSet(key, value) {
  if (typeof window !== "undefined" && window.storage && typeof window.storage.set === "function") {
    await window.storage.set(key, JSON.stringify(value), false);
    return;
  }
  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.setItem(`peags:${key}`, JSON.stringify(value));
    return;
  }
  throw new Error("No storage available in this environment");
}

function statusColor(days) {
  if (days <= 7) return "#E5484D";
  if (days <= 30) return "#F2A93B";
  return "#37C9A6";
}

function dueText(item) {
  if (!item) return "No dates set yet";
  if (item.days < 0) return `${item.title} overdue by ${Math.abs(item.days)}d`;
  if (item.days === 0) return `${item.title} due today`;
  return `${item.title} due in ${item.days} days`;
}

function carSummary(car) {
  const makeModel = [car.year, car.make, car.model].filter(Boolean).join(" ");
  const parts = [makeModel, car.reg, car.mileage ? `${Number(car.mileage).toLocaleString()} mi` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No vehicle added yet";
}

// ---------- circular gauge (signature element) ----------
function Dial({ pct, color, size = 56, stroke = 6, label, sub }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, pct));
  return (
    <div className="flex items-center gap-3">
      <svg width={size} height={size} className="-rotate-90 shrink-0">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#2A2B30" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeDasharray={c} strokeDashoffset={c * (1 - clamped)} strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.6s ease" }}
        />
      </svg>
      <div className="min-w-0">
        <div className="font-mono text-sm tracking-tight" style={{ color }}>{label}</div>
        {sub && <div className="text-[11px] text-white truncate max-w-[140px]">{sub}</div>}
      </div>
    </div>
  );
}

// ---------- horizontal bar chart of everything coming due, soonest at the top ----------
function UpcomingChart({ items }) {
  if (!items || items.length === 0) return null;

  const sorted = [...items].sort((a, b) => a.days - b.days).slice(0, 6);
  const data = sorted.map((it) => ({
    ...it,
    // bar length is directly proportional to days left (overdue items get a small visible sliver)
    barValue: Math.max(2, it.days),
  }));

  // Colour is relative to what's actually in this list — soonest third red, middle
  // third amber, farthest third green — rather than fixed day-count bands, so the
  // chart always shows a useful gradient whether everything's due this month or
  // spread out over a year. Overdue items are always red regardless.
  function relativeColor(index, days) {
    if (days < 0) return "#E5484D";
    if (data.length <= 1) return statusColor(days);
    const pos = index / (data.length - 1);
    if (pos < 1 / 3) return "#E5484D";
    if (pos < 2 / 3) return "#F2A93B";
    return "#37C9A6";
  }

  const chartHeight = Math.max(90, data.length * 40);

  function DaysLabel(props) {
    const { x, y, width, height, index } = props;
    const item = data[index];
    if (!item) return null;
    const text = item.days < 0 ? `${Math.abs(item.days)}d overdue` : item.days === 0 ? "today" : `${item.days}d`;
    return (
      <text x={x + width + 8} y={y + height / 2} dy={4} fill={relativeColor(index, item.days)} fontSize={11} fontFamily="'JetBrains Mono', ui-monospace, monospace" fontWeight={600}>
        {text}
      </text>
    );
  }

  return (
    <div className="border border-[#2A2B30] rounded-2xl p-4 mb-4"
      style={{ background: "var(--panel-tint)" }}
    >
      <div className="text-[11px] font-mono uppercase tracking-wide text-white opacity-60 mb-1 px-1">Coming up</div>
      <div style={{ height: chartHeight }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 64, bottom: 4, left: 0 }}>
            <XAxis type="number" hide domain={[0, "dataMax"]} />
            <YAxis type="category" dataKey="title" width={112} tick={{ fill: "#FFFFFF", fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip
              cursor={{ fill: "rgba(255,255,255,0.04)" }}
              contentStyle={{ background: "#0E0F11", border: "1px solid #2A2B30", fontSize: 12 }}
              labelStyle={{ color: "#FFFFFF" }}
              formatter={(_value, _name, props) => [dueText(props.payload), ""]}
            />
            <Bar dataKey="barValue" radius={[0, 6, 6, 0]} barSize={14} label={DaysLabel}>
              {data.map((entry, i) => (
                <Cell key={i} fill={relativeColor(i, entry.days)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
function Header({ car, nextDue, onOpenNotifications, onOpenCustomize, notifyEnabled, permission }) {
  const alertsOn = notifyEnabled && permission === "granted";
  return (
    <header className="border-b border-[#232428] bg-[#0E0F11]/80 backdrop-blur sticky top-0 z-10" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      <div className="max-w-2xl mx-auto px-5 py-3 flex items-center gap-3">
        <div
          className="w-11 h-11 rounded-full flex items-center justify-center shrink-0 relative"
          style={{
            background: "conic-gradient(from 220deg, #C88A54, #E7E8EA 35%, #6E7074 55%, #C88A54 80%, #C88A54)",
            padding: "1.5px",
          }}
        >
          <div
            className="w-full h-full rounded-full flex items-center justify-center"
            style={{ background: "radial-gradient(circle at 35% 25%, #2A2B30, #0A0B0C 75%)" }}
          >
            <span className="chrome-text font-extrabold text-[11px] tracking-tight">PCC</span>
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-extrabold leading-tight tracking-tight text-white truncate">PEAGS Car Companion</div>
          {(() => {
            const summary = carSummary(car);
            return summary !== "No vehicle added yet" ? (
              <div className="text-[11px] text-white font-mono truncate">{summary}</div>
            ) : null;
          })()}
        </div>

        {nextDue && (
          <div className="flex items-center gap-2 shrink-0">
            <span className="w-2 h-2 rounded-full" style={{ background: statusColor(nextDue.days) }} />
            <span className="text-[12px] font-mono text-white whitespace-nowrap hidden sm:inline">{dueText(nextDue)}</span>
          </div>
        )}

        <button
          onClick={onOpenCustomize}
          className="w-11 h-11 rounded-full flex items-center justify-center shrink-0 hover:bg-[#232428] transition-colors"
          title="Customize"
        >
          <Palette size={19} color="#FFFFFF" />
        </button>

        <button
          onClick={onOpenNotifications}
          className="w-11 h-11 rounded-full flex items-center justify-center shrink-0 hover:bg-[#232428] transition-colors -mr-2"
          title="Reminders & notifications"
        >
          {alertsOn ? <BellRing size={19} color="#37C9A6" /> : <Bell size={19} color="#FFFFFF" />}
        </button>
      </div>
    </header>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.75)", zIndex: 100 }}
      onClick={onClose}
    >
      <div
        className="rounded-2xl p-6 w-full max-w-sm"
        style={{ background: "var(--panel-tint, #18191C)", border: "1px solid #2A2B30", boxShadow: "0 20px 50px rgba(0,0,0,0.7)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-[15px] font-bold text-white">{title}</h4>
          <button onClick={onClose} className="text-white hover:text-white">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function FormInput({ extraClass = "", ...props }) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      {...props}
      onFocus={(e) => { setFocused(true); props.onFocus && props.onFocus(e); }}
      onBlur={(e) => { setFocused(false); props.onBlur && props.onBlur(e); }}
      className={"w-full border rounded-md px-3 py-2 text-sm focus:outline-none transition-colors mb-3 " + extraClass}
      style={{
        background: focused ? "#FFFFFF" : "#0E0F11",
        color: focused ? "#000000" : "#FFFFFF",
        borderColor: focused ? "#9A9DA2" : "#2A2B30",
        caretColor: focused ? "#000000" : "#FFFFFF",
      }}
    />
  );
}

// ---- reference lists used to power autocomplete suggestions ----
const CAR_MAKES = [
  "Audi", "BMW", "Citroën", "Dacia", "Fiat", "Ford", "Honda", "Hyundai", "Jaguar", "Jeep",
  "Kia", "Land Rover", "Lexus", "Mazda", "Mercedes-Benz", "MINI", "Mitsubishi", "Nissan",
  "Peugeot", "Porsche", "Renault", "SEAT", "Škoda", "Smart", "Subaru", "Suzuki", "Tesla",
  "Toyota", "Vauxhall", "Volkswagen", "Volvo",
];
const MODELS_BY_MAKE = {
  Audi: ["A1", "A3", "A4", "A5", "A6", "Q2", "Q3", "Q5", "Q7", "TT", "e-tron"],
  BMW: ["1 Series", "2 Series", "3 Series", "4 Series", "5 Series", "X1", "X2", "X3", "X5", "i3", "i4"],
  Ford: ["Fiesta", "Focus", "Puma", "Kuga", "EcoSport", "Mondeo", "Ka", "Galaxy", "S-Max", "Ranger"],
  Volkswagen: ["Golf", "Golf GTD", "Golf GTI", "Polo", "Passat", "Tiguan", "T-Roc", "Up!", "Touran", "ID.3", "ID.4"],
  Vauxhall: ["Corsa", "Astra", "Insignia", "Mokka", "Crossland", "Grandland", "Viva"],
  Toyota: ["Yaris", "Corolla", "RAV4", "Aygo", "C-HR", "Prius", "Land Cruiser", "Hilux"],
  Nissan: ["Qashqai", "Juke", "Micra", "Leaf", "X-Trail", "Note"],
  Honda: ["Civic", "Jazz", "CR-V", "HR-V", "e"],
  Peugeot: ["208", "2008", "308", "3008", "508", "5008"],
  Renault: ["Clio", "Captur", "Megane", "Kadjar", "Zoe"],
  Hyundai: ["i10", "i20", "i30", "Tucson", "Kona", "Santa Fe"],
  Kia: ["Picanto", "Rio", "Ceed", "Sportage", "Niro", "Sorento"],
  "Mercedes-Benz": ["A-Class", "B-Class", "C-Class", "E-Class", "GLA", "GLC", "GLE"],
  Škoda: ["Fabia", "Octavia", "Superb", "Kamiq", "Karoq", "Kodiaq"],
  SEAT: ["Ibiza", "Leon", "Arona", "Ateca", "Tarraco"],
  MINI: ["Hatch", "Countryman", "Clubman", "Convertible"],
  "Land Rover": ["Defender", "Discovery", "Range Rover", "Range Rover Sport", "Range Rover Evoque", "Freelander"],
  Mazda: ["2", "3", "6", "CX-3", "CX-5", "MX-5"],
  Fiat: ["500", "Panda", "Tipo", "500X"],
  "Citroën": ["C1", "C3", "C4", "C5 Aircross", "Berlingo"],
  Dacia: ["Sandero", "Duster", "Jogger"],
  Jaguar: ["XE", "XF", "F-Pace", "E-Pace", "F-Type"],
  Volvo: ["XC40", "XC60", "XC90", "S60", "V40", "V60"],
  Tesla: ["Model 3", "Model S", "Model X", "Model Y"],
  Subaru: ["Impreza", "Forester", "Outback", "XV"],
  Suzuki: ["Swift", "Vitara", "Ignis", "S-Cross"],
  Mitsubishi: ["Outlander", "ASX", "Space Star"],
  Porsche: ["911", "Cayenne", "Macan", "Panamera", "Taycan"],
  Lexus: ["IS", "ES", "NX", "RX", "UX"],
  Jeep: ["Renegade", "Compass", "Cherokee", "Wrangler"],
  Smart: ["ForTwo", "ForFour"],
};
const INSURANCE_PROVIDERS = [
  "Aviva", "Direct Line", "Admiral", "AA Insurance", "Churchill", "LV=", "NFU Mutual",
  "Hastings Direct", "Saga", "Tesco Bank", "RAC Insurance", "More Than", "Sheilas' Wheels",
  "1st Central", "esure", "Zurich", "Co-op Insurance",
];
const SERVICE_TASKS = [
  "Oil & filter service", "Full service", "Interim service", "Brake pads (front)",
  "Brake pads (rear)", "Brake discs", "Tyres (front)", "Tyres (rear)", "Battery replacement",
  "Air filter", "Cambelt / timing belt", "Wiper blades", "Coolant flush", "Spark plugs",
  "Air conditioning re-gas", "Wheel alignment",
];
const REPAIR_DESCRIPTIONS = [
  "Front tyres replaced", "Rear tyres replaced", "Battery replacement", "Brake pads replaced",
  "Brake discs replaced", "Clutch replacement", "Exhaust repair", "Suspension repair",
  "Windscreen replacement", "Alternator replacement", "Starter motor replacement",
  "Wheel bearing replacement", "Timing belt replacement", "Radiator repair", "Puncture repair",
];

// ---- accent colour themes for the Customize page — controls primary buttons, toggles, and focus states ----
const THEMES = {
  platinum: { name: "Platinum", light: "#F0F1F2", mid: "#C7C9CC", dark: "#9A9DA2", bgTint: "#232428", panelTint: "#18191C" },
  emerald: { name: "Emerald", light: "#7EEAC9", mid: "#37C9A6", dark: "#1F8F73", bgTint: "#153029", panelTint: "#122622" },
  teal: { name: "Teal", light: "#7DE8E0", mid: "#2DBDB4", dark: "#1C8880", bgTint: "#0F2E2C", panelTint: "#0C2422" },
  sapphire: { name: "Sapphire", light: "#9DBEFF", mid: "#4C8DFF", dark: "#2A5FCC", bgTint: "#152840", panelTint: "#111F31" },
  violet: { name: "Violet", light: "#C4B0FC", mid: "#A78BFA", dark: "#7C5FD1", bgTint: "#241D3B", panelTint: "#1A1530" },
  pink: { name: "Pink", light: "#FFC2DE", mid: "#FF6FA5", dark: "#CC4A7D", bgTint: "#341829", panelTint: "#291320" },
  ruby: { name: "Ruby", light: "#FF9DA1", mid: "#E5484D", dark: "#B23237", bgTint: "#38191C", panelTint: "#291316" },
  gold: { name: "Gold", light: "#F0C98A", mid: "#D9A45B", dark: "#B07E3D", bgTint: "#332913", panelTint: "#26200F" },
};

// ---- text input with a click-to-fill suggestions dropdown ----
function AutocompleteInput({ value, onChange, options, ...rest }) {
  const [open, setOpen] = useState(false);
  const matches =
    value && value.trim().length > 0
      ? options.filter((o) => o.toLowerCase().includes(value.toLowerCase())).slice(0, 6)
      : options.slice(0, 6);

  return (
    <div className="relative">
      <FormInput
        {...rest}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        autoComplete="off"
      />
      {open && matches.length > 0 && (
        <div
          className="absolute left-0 right-0 -mt-2 rounded-md overflow-hidden max-h-48 overflow-y-auto"
          style={{
            zIndex: 50,
            background: "#0E0F11",
            border: "1px solid #2A2B30",
            boxShadow: "0 10px 30px rgba(0,0,0,0.6)",
          }}
        >
          {matches.map((m, i) => (
            <button
              key={m}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onChange(m); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-sm transition-colors"
              style={{ background: "#0E0F11", color: "#FFFFFF", borderTop: i === 0 ? "none" : "1px solid #2A2B30" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#232428")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "#0E0F11")}
            >
              {m}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DeleteButton({ onClick, title }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="p-1 transition-colors"
      title={title}
    >
      <Trash2 size={15} color={hover ? "#E5484D" : "#FFFFFF"} />
    </button>
  );
}

function SaveButton({ onSave }) {
  const [status, setStatus] = useState("idle"); // idle | saving | saved | error

  async function handleClick() {
    setStatus("saving");
    try {
      await onSave();
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 1600);
    } catch (e) {
      setStatus("error");
      setTimeout(() => setStatus("idle"), 2200);
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={status === "saving"}
      className="chrome-btn font-semibold rounded-md px-3 py-1.5 text-[12px] flex items-center gap-1.5 disabled:opacity-60"
      title="Save"
    >
      {status === "idle" && <Save size={13} />}
      {status === "saving" && <Loader2 size={13} className="animate-spin" />}
      {status === "saved" && <Check size={13} />}
      {status === "error" && <AlertCircle size={13} />}
      {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : status === "error" ? "Failed" : "Save"}
    </button>
  );
}

// ---- finds nearby garages via a live web search (uses the Claude API bridge available in this artifact) ----
function GarageFinder({ label, searchTerm, postcode, setPostcode }) {
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${searchTerm} near ${postcode.trim()}`)}`;

  return (
    <div className="border border-[#2A2B30] rounded-2xl p-5"
      style={{ background: "var(--panel-tint)" }}
    >
      <h3 className="text-sm font-bold text-white mb-1">{label}</h3>
      <p className="text-[12px] text-white mb-3">Enter your postcode to see real, live results on Google Maps.</p>
      <div className="flex gap-2">
        <FormInput
          extraClass="mb-0"
          placeholder="e.g. SW1A 1AA"
          value={postcode}
          onChange={(e) => setPostcode(e.target.value.toUpperCase())}
        />
        <a
          href={postcode.trim() ? mapsUrl : undefined}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => { if (!postcode.trim()) e.preventDefault(); }}
          className="chrome-btn font-semibold rounded-md px-4 text-sm flex items-center gap-1.5 shrink-0"
          style={{ opacity: postcode.trim() ? 1 : 0.4, pointerEvents: postcode.trim() ? "auto" : "none" }}
        >
          <MapPin size={14} />
        </a>
      </div>
      <p className="text-[11px] text-white opacity-60 mt-3">
        Opens Google Maps in a new tab with live, real results — free, no setup needed.
      </p>
    </div>
  );
}

// ---- finds currently well-regarded UK car insurance sites via live web search ----
const INSURANCE_SITES = [
  { name: "Compare the Market", url: "https://www.comparethemarket.com/car-insurance/", description: "Well-known UK comparison site, often has meerkat toy offers." },
  { name: "MoneySuperMarket", url: "https://www.moneysupermarket.com/car-insurance/", description: "Large UK comparison site covering car, home, and more." },
  { name: "Confused.com", url: "https://www.confused.com/car-insurance", description: "One of the original UK insurance comparison sites." },
  { name: "GoCompare", url: "https://www.gocompare.com/car-insurance/", description: "UK comparison site covering dozens of insurers." },
  { name: "Uswitch", url: "https://www.uswitch.com/car-insurance/", description: "Comparison site covering insurance, energy, and broadband." },
  { name: "Direct Line", url: "https://www.directline.com/car-insurance", description: "Major UK insurer that doesn't appear on comparison sites." },
];

function InsuranceFinder() {
  return (
    <div className="border border-[#2A2B30] rounded-2xl p-5"
      style={{ background: "var(--panel-tint)" }}
    >
      <h3 className="text-sm font-bold text-white mb-1">Compare insurance sites</h3>
      <p className="text-[12px] text-white mb-3">Well-known UK sites to compare quotes on — free, no search needed.</p>
      <div className="flex flex-col gap-2">
        {INSURANCE_SITES.map((r, i) => (
          <a
            key={i}
            href={r.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-start gap-3 border-t border-[#2A2B30] pt-2.5 first:border-0 first:pt-0 hover:opacity-80 transition-opacity"
          >
            <CalendarClock size={15} color="#7D8087" className="shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="text-sm text-white font-medium truncate">{r.name}</div>
              <div className="text-[11px] text-white opacity-70 truncate">{r.description}</div>
            </div>
          </a>
        ))}
      </div>
      <p className="text-[11px] text-white opacity-60 mt-3">
        Not a recommendation or paid placement — just well-known, established sites. Compare terms carefully.
      </p>
    </div>
  );
}

// ---------- main app ----------
export default function PeagsCarCompanion() {
  const [car, setCar] = useState({ make: "", model: "", year: "", reg: "", mileage: "", purchasePrice: "", purchaseDate: "" });

  const [reminders, setReminders] = useState([]);
  const [mot, setMot] = useState({ expiry: "" });
  const [insurance, setInsurance] = useState({ renewal: "", provider: "", premium: 0 });
  const [roadTax, setRoadTax] = useState({ renewal: "", cost: "" });
  const [fuelLogs, setFuelLogs] = useState([]);
  const [repairs, setRepairs] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [postcode, setPostcode] = useState("");
  const [accentTheme, setAccentTheme] = useState("platinum");

  // notification preferences
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const [leadDays, setLeadDays] = useState(7);
  const [permission, setPermission] = useState(
    typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported"
  );
  const notifiedRef = useRef(new Set());

  // phone push notifications (work even when the app is closed — requires deployment, see README)
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState(null);

  const [section, setSection] = useState(null); // null = menu list
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [editingId, setEditingId] = useState(null); // id of the entry being edited, or null when adding new

  // ---- load anything previously saved, once, on first open ----
  useEffect(() => {
    (async () => {
      const [savedCar, savedReminders, savedMot, savedInsurance, savedRoadTax, savedFuel, savedRepairs, savedDocuments, savedNotif, savedTheme] =
        await Promise.all([
          storageGet("car"),
          storageGet("reminders"),
          storageGet("mot"),
          storageGet("insurance"),
          storageGet("roadTax"),
          storageGet("fuelLogs"),
          storageGet("repairs"),
          storageGet("documents"),
          storageGet("notifications"),
          storageGet("theme"),
        ]);
      if (savedCar) setCar(savedCar);
      if (savedReminders) setReminders(savedReminders);
      if (savedMot) setMot(savedMot);
      if (savedInsurance) setInsurance(savedInsurance);
      if (savedRoadTax) setRoadTax(savedRoadTax);
      if (savedFuel) setFuelLogs(savedFuel);
      if (savedRepairs) setRepairs(savedRepairs);
      if (savedDocuments) setDocuments(savedDocuments);
      if (savedNotif) {
        setNotifyEnabled(!!savedNotif.notifyEnabled);
        setLeadDays(savedNotif.leadDays || 7);
      }
      if (savedTheme && THEMES[savedTheme]) setAccentTheme(savedTheme);
    })();
  }, []);

  // ---- check whether phone push notifications are already enabled on this device ----
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setPushSubscribed(!!sub))
      .catch(() => {}); // not supported in this context (e.g. inside a Claude artifact preview) — fails silently
  }, []);

  const motDays = mot.expiry ? daysUntil(mot.expiry) : null;
  const insDays = insurance.renewal ? daysUntil(insurance.renewal) : null;
  const taxDays = roadTax.renewal ? daysUntil(roadTax.renewal) : null;
  const nextReminder = [...reminders].sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))[0];
  const reminderDays = nextReminder ? daysUntil(nextReminder.dueDate) : null;

  // ---- figure out which item is due soonest, with a readable title ----
  const nextDue = useMemo(() => {
    const candidates = [
      ...(motDays !== null ? [{ title: "MOT", days: motDays }] : []),
      ...(insDays !== null ? [{ title: "Insurance renewal", days: insDays }] : []),
      ...(taxDays !== null ? [{ title: "Road tax", days: taxDays }] : []),
      ...(nextReminder ? [{ title: nextReminder.task, days: reminderDays }] : []),
    ];
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (a.days <= b.days ? a : b));
  }, [motDays, insDays, taxDays, nextReminder, reminderDays]);

  // ---- every upcoming due date, for the "Coming up" chart on the menu page ----
  const allDueItems = useMemo(() => {
    return [
      ...(motDays !== null ? [{ title: "MOT", days: motDays }] : []),
      ...(insDays !== null ? [{ title: "Insurance renewal", days: insDays }] : []),
      ...(taxDays !== null ? [{ title: "Road tax", days: taxDays }] : []),
      ...reminders.map((r) => ({ title: r.task, days: daysUntil(r.dueDate) })),
    ];
  }, [motDays, insDays, taxDays, reminders]);

  // ---- fire a browser notification once the lead-time window is reached ----
  useEffect(() => {
    if (!notifyEnabled || permission !== "granted" || !nextDue) return;
    if (nextDue.days > leadDays) return;
    const key = `${nextDue.title}-${nextDue.days}-${leadDays}`;
    if (notifiedRef.current.has(key)) return;
    notifiedRef.current.add(key);
    try {
      new Notification("PEAGS Car Companion", { body: dueText(nextDue) });
    } catch (e) {
      // notifications may be blocked in this preview context; the in-app banner still shows the alert
    }
  }, [notifyEnabled, permission, leadDays, nextDue]);

  function requestNotifications() {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setPermission("unsupported");
      return;
    }
    Notification.requestPermission().then((perm) => {
      setPermission(perm);
      if (perm === "granted") setNotifyEnabled(true);
    });
  }

  const fuelTotal = fuelLogs.reduce((s, f) => s + Number(f.cost), 0);
  const repairTotal = repairs.reduce((s, r) => s + Number(r.cost), 0);
  const annualRecurringCost = Number(insurance.premium || 0) + Number(roadTax.cost || 0);
  const totalLoggedSpend = fuelTotal + repairTotal + annualRecurringCost;

  const fuelChartData = [...fuelLogs].sort((a, b) => new Date(a.date) - new Date(b.date)).map((f) => ({ date: fmtDate(f.date).slice(0, 6), cost: Number(f.cost) }));

  // ---- vehicle description used to build direct links to free valuation tools ----
  const vehicleSearchDesc = [car.year, car.make, car.model].filter(Boolean).join(" ");

  // ---- explicit per-section save handlers, called by each Save button ----
  const saveVehicle = () => storageSet("car", car);
  const saveReminders = () => storageSet("reminders", reminders);
  const saveMot = () => storageSet("mot", mot);
  const saveInsurance = () => storageSet("insurance", insurance);
  const saveRoadTax = () => storageSet("roadTax", roadTax);
  const saveFuel = () => storageSet("fuelLogs", fuelLogs);
  const saveRepairs = () => storageSet("repairs", repairs);
  const saveDocuments = () => storageSet("documents", documents);

  // ---- builds the list of due dates sent to the server so it knows what to check ----
  function buildReminderSnapshot() {
    const items = [];
    if (mot.expiry) items.push({ title: "MOT", dueDate: mot.expiry });
    if (insurance.renewal) items.push({ title: "Insurance renewal", dueDate: insurance.renewal });
    if (roadTax.renewal) items.push({ title: "Road tax", dueDate: roadTax.renewal });
    reminders.forEach((r) => r.dueDate && items.push({ title: r.task, dueDate: r.dueDate }));
    return items;
  }

  // ---- sends the current subscription + due-date snapshot to the backend, keeping the server in sync ----
  async function syncPushReminders(subscriptionArg) {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = subscriptionArg || (await reg.pushManager.getSubscription());
    if (!sub) return;
    const response = await fetch("/api/save-subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON(), leadDays, reminders: buildReminderSnapshot() }),
    });
    if (!response.ok) throw new Error("Sync failed");
  }

  // ---- turns phone push notifications on: registers the service worker, asks permission, subscribes ----
  async function enablePhonePush() {
    setPushError(null);
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setPushError("Push notifications aren't supported in this browser or context.");
      return;
    }
    const vapidKey = typeof window !== "undefined" ? window.VAPID_PUBLIC_KEY : undefined;
    if (!vapidKey) {
      setPushError("Not set up yet — this deployment is missing its VAPID key. See the README.");
      return;
    }
    setPushBusy(true);
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      const permissionResult = await Notification.requestPermission();
      if (permissionResult !== "granted") {
        setPushError("Notification permission wasn't granted.");
        setPushBusy(false);
        return;
      }
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey),
        });
      }
      await syncPushReminders(sub);
      setPushSubscribed(true);
    } catch (e) {
      setPushError("Couldn't enable phone notifications. Make sure this app is deployed with push set up (see README) — this won't work in the Claude preview.");
    } finally {
      setPushBusy(false);
    }
  }

  const saveNotifications = async () => {
    await storageSet("notifications", { notifyEnabled, leadDays });
    if (pushSubscribed) {
      try {
        await syncPushReminders();
      } catch (e) {
        // local settings still saved even if the server sync fails
      }
    }
  };

  const saveHandlers = {
    vehicle: saveVehicle,
    reminders: saveReminders,
    mot: saveMot,
    insurance: saveInsurance,
    roadtax: saveRoadTax,
    fuel: saveFuel,
    repairs: saveRepairs,
    documents: saveDocuments,
    notifications: saveNotifications,
  };

  function addReminder() {
    if (!form.task || !form.dueDate) return;
    if (editingId) {
      setReminders((rs) => rs.map((x) => (x.id === editingId ? { ...x, task: form.task, dueDate: form.dueDate, mileage: form.mileage || "" } : x)));
    } else {
      setReminders((r) => [...r, { id: Date.now(), task: form.task, dueDate: form.dueDate, mileage: form.mileage || "" }]);
    }
    setForm({}); setEditingId(null); setModal(null);
  }
  function addFuel() {
    if (!form.date || !form.cost) return;
    if (editingId) {
      setFuelLogs((fs) => fs.map((x) => (x.id === editingId ? { ...x, date: form.date, cost: Number(form.cost) } : x)));
    } else {
      setFuelLogs((f) => [...f, { id: Date.now(), date: form.date, cost: Number(form.cost) }]);
    }
    setForm({}); setEditingId(null); setModal(null);
  }
  function addRepair() {
    if (!form.date || !form.desc || !form.cost) return;
    if (editingId) {
      setRepairs((rs) => rs.map((x) => (x.id === editingId ? { ...x, date: form.date, desc: form.desc, cost: Number(form.cost) } : x)));
    } else {
      setRepairs((r) => [...r, { id: Date.now(), date: form.date, desc: form.desc, cost: Number(form.cost) }]);
    }
    setForm({}); setEditingId(null); setModal(null);
  }
  function uploadDocuments(fileList) {
    const files = Array.from(fileList || []);
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        setDocuments((docs) => [
          ...docs,
          { id: Date.now() + Math.random(), name: file.name, size: file.size, type: file.type, dataUrl: reader.result, uploadedDate: new Date().toISOString() },
        ]);
      };
      reader.readAsDataURL(file);
    });
    setModal(null);
  }

  // ---- section menu config ----
  const sections = [
    {
      key: "vehicle", icon: Car, accent: "#E7E8EA", title: "My vehicle",
      summary: car.make || car.model || car.reg ? carSummary(car) : "Add your vehicle details",
    },
    {
      key: "reminders", icon: Wrench, accent: "#C9CBCE", title: "Service reminders",
      summary: nextReminder ? dueText({ title: nextReminder.task, days: reminderDays }) : "No reminders set",
    },
    {
      key: "mot", icon: ShieldCheck, accent: "#9BA4AD", title: "MOT tracking",
      summary: motDays !== null ? dueText({ title: "MOT", days: motDays }) : "No MOT date set",
    },
    {
      key: "insurance", icon: CalendarClock, accent: "#7D8087", title: "Insurance renewal",
      summary: insDays !== null ? dueText({ title: "Insurance", days: insDays }) : "No renewal date set",
    },
    {
      key: "roadtax", icon: Receipt, accent: "#B4A896", title: "Road tax",
      summary: taxDays !== null ? dueText({ title: "Road tax", days: taxDays }) : "No renewal date set",
    },
    {
      key: "fuel", icon: Fuel, accent: "#D9A45B", title: "Fuel & charging costs",
      summary: fuelLogs.length ? `${fmtGBP(fuelTotal)} across ${fuelLogs.length} entries` : "No entries logged yet",
    },
    {
      key: "repairs", icon: ClipboardList, accent: "#9A9DA2", title: "Repair history",
      summary: repairs.length ? `${fmtGBP(repairTotal)} total logged` : "No repairs logged yet",
    },
    {
      key: "resale", icon: TrendingDown, accent: "#C88A54", title: "Predicted resale value",
      summary: "Get a free valuation from real sites",
    },
    {
      key: "documents", icon: FileText, accent: "#8FA3B0", title: "Documents & certificates",
      summary: documents.length ? `${documents.length} file${documents.length !== 1 ? "s" : ""} stored` : "No files uploaded yet",
    },
    {
      key: "ownership", icon: PoundSterling, accent: "#8FBF9F", title: "Cost of ownership",
      summary: totalLoggedSpend > 0 ? `${fmtGBP(totalLoggedSpend)} logged so far` : "See everything this car has cost you",
    },
    {
      key: "notifications", icon: notifyEnabled && permission === "granted" ? BellRing : Bell, accent: "#D6A8C9",
      title: "Reminders & notifications",
      summary: notifyEnabled && permission === "granted" ? `Alerts on · ${leadDays}d before due` : "Alerts off",
    },
    {
      key: "customize", icon: Palette, accent: THEMES[accentTheme].mid,
      title: "Customize",
      summary: `${THEMES[accentTheme].name} theme`,
    },
  ];
  const active = sections.find((s) => s.key === section);
  const leadOptions = [1, 3, 7, 14, 30];

  return (
    <div
      className="min-h-screen w-full text-[#F2F2F3]"
      style={{
        fontFamily: "Inter, ui-sans-serif, system-ui",
        background: `radial-gradient(circle at 50% 0%, ${THEMES[accentTheme].bgTint} 0%, #0E0F11 55%, #0A0B0C 100%)`,
        "--accent-light": THEMES[accentTheme].light,
        "--accent-mid": THEMES[accentTheme].mid,
        "--accent-dark": THEMES[accentTheme].dark,
        "--panel-tint": THEMES[accentTheme].panelTint,
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap');
        .font-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
        .chrome-text {
          background: linear-gradient(160deg, #FFFFFF 0%, #C7C9CC 35%, #85878B 55%, #E8E9EB 75%, #9A9DA2 100%);
          -webkit-background-clip: text; background-clip: text; color: transparent;
        }
        .chrome-btn { background: linear-gradient(160deg, var(--accent-light) 0%, var(--accent-mid) 40%, var(--accent-dark) 60%, var(--accent-light) 100%); color: #0E0F11; }
        .accent-text { color: var(--accent-mid); }
      `}</style>

      <Header
        car={car}
        nextDue={nextDue}
        onOpenNotifications={() => setSection("notifications")}
        onOpenCustomize={() => setSection("customize")}
        notifyEnabled={notifyEnabled}
        permission={permission}
      />

      <main className="max-w-2xl mx-auto px-5 py-6">
        {!section && (
          <>
            <h1 className="text-2xl font-extrabold text-white mb-3 tracking-tight">Menu</h1>
            <UpcomingChart items={allDueItems} />
            <div className="flex flex-col gap-3">
              {sections.filter((s) => s.key !== "notifications" && s.key !== "customize").map((s) => (
                <button
                  key={s.key}
                  onClick={() => setSection(s.key)}
                  className="w-full flex items-center gap-4 border border-[#2A2B30] hover:border-[#3A3B40] rounded-2xl p-4 text-left transition-colors"
                  style={{ background: "var(--panel-tint)" }}
                >
                  <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: s.accent + "1F" }}>
                    <s.icon size={20} color={s.accent} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[16px] font-bold text-white leading-tight">{s.title}</div>
                    <div className="text-[13px] text-white truncate mt-0.5">{s.summary}</div>
                  </div>
                  <ChevronRight size={18} color="#FFFFFF" className="shrink-0" />
                </button>
              ))}
            </div>
          </>
        )}

        {active && (
          <div>
            <button
              onClick={() => setSection(null)}
              className="flex items-center gap-1.5 text-[13px] text-white hover:text-white mb-5 transition-colors"
            >
              <ArrowLeft size={15} /> Menu
            </button>

            <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: active.accent + "1F" }}>
                  <active.icon size={20} color={active.accent} />
                </div>
                <h1 className="text-2xl font-extrabold text-white tracking-tight">{active.title}</h1>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {saveHandlers[section] && <SaveButton onSave={saveHandlers[section]} />}
                {["mot", "insurance", "roadtax"].includes(section) && (
                  <button
                    onClick={() => { setEditingId(null); setForm({}); setModal(section); }}
                    className="rounded-lg px-3 py-2 flex items-center gap-1.5 text-white hover:bg-[#232428] transition-colors text-[12px] font-semibold border border-[#2A2B30]"
                    title="Edit"
                  >
                    <Pencil size={14} /> Edit
                  </button>
                )}
                {["reminders", "fuel", "repairs", "documents"].includes(section) && (
                  <button
                    onClick={() => { setEditingId(null); setForm({}); setModal(section); }}
                    className="w-9 h-9 rounded-lg flex items-center justify-center text-white hover:text-white hover:bg-[#232428] transition-colors"
                    title="Add"
                  >
                    <Plus size={18} />
                  </button>
                )}
              </div>
            </div>

            {section === "vehicle" && (
              <div className="border border-[#2A2B30] rounded-2xl p-5 flex flex-col gap-4"
                style={{ background: "var(--panel-tint)" }}
              >
                <p className="text-[13px] text-white">Update your vehicle's details. Changes apply straight away.</p>
                <div>
                  <label className="block text-[12px] font-semibold text-white mb-1.5">Make</label>
                  <AutocompleteInput
                    value={car.make}
                    placeholder="e.g. Volkswagen"
                    options={CAR_MAKES}
                    onChange={(val) => setCar({ ...car, make: val })}
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-white mb-1.5">Model</label>
                  <AutocompleteInput
                    value={car.model}
                    placeholder="e.g. Golf GTD"
                    options={MODELS_BY_MAKE[car.make] || []}
                    onChange={(val) => setCar({ ...car, model: val })}
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-white mb-1.5">Manufacture year</label>
                  <FormInput
                    type="number"
                    value={car.year}
                    placeholder="e.g. 2019"
                    onChange={(e) => setCar({ ...car, year: e.target.value === "" ? "" : Number(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-white mb-1.5">Registration</label>
                  <FormInput value={car.reg} placeholder="e.g. LK19 XPR" onChange={(e) => setCar({ ...car, reg: e.target.value.toUpperCase() })} />
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-white mb-1.5">Current mileage</label>
                  <FormInput type="number" value={car.mileage} placeholder="e.g. 42800" onChange={(e) => setCar({ ...car, mileage: e.target.value === "" ? "" : Number(e.target.value) })} />
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-white mb-1.5">Purchase price (£)</label>
                  <FormInput type="number" value={car.purchasePrice} placeholder="e.g. 24500" onChange={(e) => setCar({ ...car, purchasePrice: e.target.value === "" ? "" : Number(e.target.value) })} />
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-white mb-1.5">Purchase date</label>
                  <FormInput extraClass="mb-0" type="date" value={car.purchaseDate} onChange={(e) => setCar({ ...car, purchaseDate: e.target.value })} />
                </div>
              </div>
            )}

            {section === "reminders" && (
              <div className="flex flex-col gap-4">
                <div className="border border-[#2A2B30] rounded-2xl p-5 flex flex-col gap-3"
                  style={{ background: "var(--panel-tint)" }}
                >
                  {reminders.length === 0 && <p className="text-sm text-white">No reminders set.</p>}
                  {[...reminders].sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate)).map((r) => {
                    const d = daysUntil(r.dueDate);
                    return (
                      <div key={r.id} className="flex items-center justify-between border-t border-[#2A2B30] pt-3 first:border-0 first:pt-0">
                        <div>
                          <div className="text-sm text-white font-medium">{r.task}</div>
                          <div className="text-[12px] text-white">Due {fmtDate(r.dueDate)}{r.mileage ? ` · ${Number(r.mileage).toLocaleString()} mi` : ""}</div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className="text-[11px] font-mono px-2 py-1 rounded" style={{ color: statusColor(d), background: statusColor(d) + "1A" }}>
                            {d < 0 ? "OVERDUE" : `${d}d`}
                          </span>
                          <button
                            onClick={() => {
                              setEditingId(r.id);
                              setForm({ task: r.task, dueDate: r.dueDate, mileage: r.mileage || "" });
                              setModal("reminders");
                            }}
                            className="p-1 text-white hover:opacity-70 transition-opacity"
                            title="Edit reminder"
                          >
                            <Pencil size={15} />
                          </button>
                          <DeleteButton onClick={() => setReminders((rs) => rs.filter((x) => x.id !== r.id))} title="Delete reminder" />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <GarageFinder
                  label="Find a garage or mechanic"
                  searchTerm="car service garages and mechanics"
                  postcode={postcode}
                  setPostcode={setPostcode}
                />
              </div>
            )}

            {section === "mot" && (
              <div className="flex flex-col gap-4">
                <button
                  onClick={() => setModal("mot")}
                  className="border border-[#2A2B30] hover:border-[#3A3B40] rounded-2xl p-6 text-left transition-colors relative w-full"
                  style={{ background: "var(--panel-tint)" }}
                >
                  <span className="absolute top-4 right-4 flex items-center gap-1 text-[12px] text-white opacity-70">
                    <Pencil size={13} /> Edit
                  </span>
                  {motDays !== null ? (
                    <Dial pct={Math.max(0, Math.min(1, motDays / 365))} color={statusColor(motDays)} size={84} stroke={8}
                      label={motDays < 0 ? "EXPIRED" : `${motDays} days left`} sub={`Expires ${fmtDate(mot.expiry)}`} />
                  ) : (
                    <p className="text-sm text-white pr-14">No MOT expiry date set yet. Tap here to add one.</p>
                  )}
                </button>
                <GarageFinder
                  label="Find an MOT test centre"
                  searchTerm="MOT test centres"
                  postcode={postcode}
                  setPostcode={setPostcode}
                />
              </div>
            )}

            {section === "insurance" && (
              <div className="flex flex-col gap-4">
                <button
                  onClick={() => setModal("insurance")}
                  className="border border-[#2A2B30] hover:border-[#3A3B40] rounded-2xl p-6 text-left transition-colors relative w-full"
                  style={{ background: "var(--panel-tint)" }}
                >
                  <span className="absolute top-4 right-4 flex items-center gap-1 text-[12px] text-white opacity-70">
                    <Pencil size={13} /> Edit
                  </span>
                  {insDays !== null ? (
                    <Dial pct={Math.max(0, Math.min(1, insDays / 365))} color={statusColor(insDays)} size={84} stroke={8}
                      label={insDays < 0 ? "EXPIRED" : `${insDays} days left`}
                      sub={`${insurance.provider || "No provider set"} · ${fmtGBP(insurance.premium)}/yr · renews ${fmtDate(insurance.renewal)}`} />
                  ) : (
                    <p className="text-sm text-white pr-14">No insurance renewal date set yet. Tap here to add one.</p>
                  )}
                </button>
                <InsuranceFinder />
              </div>
            )}

            {section === "roadtax" && (
              <button
                onClick={() => setModal("roadtax")}
                className="border border-[#2A2B30] hover:border-[#3A3B40] rounded-2xl p-6 text-left transition-colors relative w-full"
                style={{ background: "var(--panel-tint)" }}
              >
                <span className="absolute top-4 right-4 flex items-center gap-1 text-[12px] text-white opacity-70">
                  <Pencil size={13} /> Edit
                </span>
                {taxDays !== null ? (
                  <Dial pct={Math.max(0, Math.min(1, taxDays / 365))} color={statusColor(taxDays)} size={84} stroke={8}
                    label={taxDays < 0 ? "EXPIRED" : `${taxDays} days left`}
                    sub={`Renews ${fmtDate(roadTax.renewal)}${roadTax.cost ? ` · ${fmtGBP(roadTax.cost)}/yr` : ""}`} />
                ) : (
                  <p className="text-sm text-white pr-14">No road tax renewal date set yet. Tap here to add one.</p>
                )}
              </button>
            )}

            {section === "fuel" && (
              <div className="border border-[#2A2B30] rounded-2xl p-5"
                style={{ background: "var(--panel-tint)" }}
              >
                <div className="flex items-baseline justify-between mb-3">
                  <span className="text-2xl font-mono text-white">{fmtGBP(fuelTotal)}</span>
                  <span className="text-[12px] text-white">last {fuelLogs.length} entries</span>
                </div>
                <div className="h-40">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={fuelChartData}>
                      <XAxis dataKey="date" tick={{ fill: "#FFFFFF", fontSize: 10 }} axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={{ background: "#18191C", border: "1px solid #2A2B30", fontSize: 12 }} formatter={(v) => fmtGBP(v)} />
                      <Bar dataKey="cost" fill="#D9A45B" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex flex-col gap-2 mt-4">
                  {[...fuelLogs].sort((a, b) => new Date(b.date) - new Date(a.date)).map((f) => (
                    <div key={f.id} className="flex items-center justify-between text-sm border-t border-[#2A2B30] pt-2 first:border-0 first:pt-0">
                      <span className="text-white">{fmtDate(f.date)}</span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="font-mono text-white">{fmtGBP(f.cost)}</span>
                        <button
                          onClick={() => {
                            setEditingId(f.id);
                            setForm({ date: f.date, cost: f.cost });
                            setModal("fuel");
                          }}
                          className="p-1 text-white hover:opacity-70 transition-opacity"
                          title="Edit entry"
                        >
                          <Pencil size={15} />
                        </button>
                        <DeleteButton onClick={() => setFuelLogs((fs) => fs.filter((x) => x.id !== f.id))} title="Delete entry" />
                      </div>
                    </div>
                  ))}
                  {fuelLogs.length === 0 && <p className="text-sm text-white">No entries logged.</p>}
                </div>
              </div>
            )}

            {section === "repairs" && (
              <div className="border border-[#2A2B30] rounded-2xl p-5"
                style={{ background: "var(--panel-tint)" }}
              >
                <div className="flex items-baseline justify-between mb-3">
                  <span className="text-lg font-mono text-white">{fmtGBP(repairTotal)}</span>
                  <span className="text-[12px] text-white">total logged</span>
                </div>
                <div className="flex flex-col gap-2">
                  {[...repairs].sort((a, b) => new Date(b.date) - new Date(a.date)).map((r) => (
                    <div key={r.id} className="flex items-center justify-between text-sm border-t border-[#2A2B30] pt-2 first:border-0 first:pt-0">
                      <div>
                        <span className="text-white">{r.desc}</span>
                        <div className="text-[11px] text-white">{fmtDate(r.date)}</div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0 ml-2">
                        <span className="font-mono text-white">{fmtGBP(r.cost)}</span>
                        <button
                          onClick={() => {
                            setEditingId(r.id);
                            setForm({ date: r.date, desc: r.desc, cost: r.cost });
                            setModal("repairs");
                          }}
                          className="p-1 text-white hover:opacity-70 transition-opacity"
                          title="Edit repair"
                        >
                          <Pencil size={15} />
                        </button>
                        <DeleteButton onClick={() => setRepairs((rs) => rs.filter((x) => x.id !== r.id))} title="Delete repair" />
                      </div>
                    </div>
                  ))}
                  {repairs.length === 0 && <p className="text-sm text-white">No repairs logged.</p>}
                </div>
              </div>
            )}

            {section === "resale" && (
              <div className="border border-[#2A2B30] rounded-2xl p-5"
                style={{ background: "var(--panel-tint)" }}
              >
                <h3 className="text-sm font-bold text-white mb-1">Get a free valuation</h3>
                <p className="text-[12px] text-white mb-3">
                  These sites give an instant, real valuation for free — just enter your reg and mileage on their site.
                </p>
                <div className="flex flex-col gap-2">
                  {[
                    { name: "WeBuyAnyCar", url: "https://www.webuyanycar.com/", description: "Instant free online valuation, sell same day." },
                    { name: "Motorway", url: "https://motorway.co.uk/sell-my-car", description: "Free valuation, dealers bid on your car." },
                    { name: "AutoTrader valuation", url: "https://www.autotrader.co.uk/car-valuation", description: "Free instant valuation from the UK's biggest listings site." },
                    { name: "Parkers valuation", url: "https://www.parkers.co.uk/car-valuation/", description: "Free valuation tool with trade-in and private sale prices." },
                  ].map((r, i) => (
                    <a
                      key={i}
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-start gap-3 border-t border-[#2A2B30] pt-2.5 first:border-0 first:pt-0 hover:opacity-80 transition-opacity"
                    >
                      <TrendingDown size={15} color="#C88A54" className="shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <div className="text-sm text-white font-medium truncate">{r.name}</div>
                        <div className="text-[11px] text-white opacity-70 truncate">{r.description}</div>
                      </div>
                    </a>
                  ))}
                </div>
                {vehicleSearchDesc && (
                  <p className="text-[11px] text-white opacity-70 mt-3">
                    Have these details ready: {vehicleSearchDesc}{car.reg ? `, reg ${car.reg}` : ""}{car.mileage ? `, ${Number(car.mileage).toLocaleString()} miles` : ""}.
                  </p>
                )}
                <p className="text-[11px] text-white opacity-60 mt-3">
                  Not a recommendation or paid placement — just well-known, free valuation tools.
                </p>
              </div>
            )}

            {section === "documents" && (
              <div className="border border-[#2A2B30] rounded-2xl p-5"
                style={{ background: "var(--panel-tint)" }}
              >
                <p className="text-[13px] text-white mb-4">
                  Keep your V5C, service contracts, warranty documents, and MOT certificates all in one place.
                </p>
                {documents.length === 0 && <p className="text-sm text-white">No files uploaded yet. Tap + to add one.</p>}
                <div className="flex flex-col gap-2">
                  {[...documents].sort((a, b) => new Date(b.uploadedDate) - new Date(a.uploadedDate)).map((d) => (
                    <div key={d.id} className="flex items-center justify-between border-t border-[#2A2B30] pt-3 first:border-0 first:pt-0">
                      <button
                        onClick={() => openDocument(d.dataUrl)}
                        className="flex items-center gap-3 min-w-0 hover:opacity-80 transition-opacity text-left"
                        title="Open file"
                      >
                        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: "#8FA3B0" + "1F" }}>
                          <FileText size={16} color="#8FA3B0" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm text-white font-medium truncate underline decoration-[#8FA3B0]/40 underline-offset-2">{d.name}</div>
                          <div className="text-[11px] text-white">{fmtBytes(d.size)} · uploaded {fmtDate(d.uploadedDate)}</div>
                        </div>
                      </button>
                      <div className="flex items-center gap-1 shrink-0 ml-2">
                        <a href={d.dataUrl} download={d.name} className="text-white hover:text-[#8FA3B0] transition-colors p-1" title="Download">
                          <Download size={15} />
                        </a>
                        <DeleteButton onClick={() => setDocuments((docs) => docs.filter((x) => x.id !== d.id))} title="Delete file" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {section === "ownership" && (
              <div className="flex flex-col gap-4">
                <div className="border border-[#2A2B30] rounded-2xl p-5"
                  style={{ background: "var(--panel-tint)" }}
                >
                  <div className="text-[12px] text-white uppercase tracking-wide font-mono mb-1">Total logged so far</div>
                  <div className="text-3xl font-mono font-bold" style={{ color: "#8FBF9F" }}>{fmtGBP(totalLoggedSpend)}</div>
                  <p className="text-[11px] text-white opacity-70 mt-1">
                    Fuel/charging + repairs logged, plus one year of insurance and road tax at current rates.
                  </p>
                </div>

                <div className="border border-[#2A2B30] rounded-2xl p-5"
                  style={{ background: "var(--panel-tint)" }}
                >
                  <h3 className="text-sm font-bold text-white mb-3">Breakdown</h3>
                  <div className="flex flex-col gap-2.5">
                    {[
                      { label: "Fuel & charging (logged)", value: fuelTotal, accent: "#D9A45B" },
                      { label: "Repairs (logged)", value: repairTotal, accent: "#9A9DA2" },
                      { label: "Insurance (per year)", value: Number(insurance.premium || 0), accent: "#7D8087" },
                      { label: "Road tax (per year)", value: Number(roadTax.cost || 0), accent: "#B4A896" },
                    ].map((row, i) => (
                      <div key={i} className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-2 text-white">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: row.accent }} />
                          {row.label}
                        </span>
                        <span className="font-mono text-white">{fmtGBP(row.value)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {annualRecurringCost > 0 && (
                  <div className="border border-[#2A2B30] rounded-2xl p-5"
                    style={{ background: "var(--panel-tint)" }}
                  >
                    <div className="text-[12px] text-white uppercase tracking-wide font-mono mb-1">Recurring, per year</div>
                    <div className="text-xl font-mono text-white">{fmtGBP(annualRecurringCost)}</div>
                    <p className="text-[11px] text-white opacity-70 mt-1">Insurance + road tax, before fuel or repairs.</p>
                    <p className="text-[11px] text-white opacity-70 mt-1">
                      ≈ {fmtGBP(annualRecurringCost / 12)} / month · {fmtGBP(annualRecurringCost / 52)} / week
                    </p>
                  </div>
                )}

                <p className="text-[11px] text-white opacity-60">
                  This adds up what you've entered elsewhere in the app — it isn't automatic and only reflects data you've logged.
                </p>
              </div>
            )}

            {section === "notifications" && (
              <div className="border border-[#2A2B30] rounded-2xl p-5 flex flex-col gap-5"
                style={{ background: "var(--panel-tint)" }}
              >
                <p className="text-[13px] text-white">
                  Get an alert before your next MOT, insurance renewal, or service reminder falls due.
                </p>

                <div className="rounded-lg px-3 py-2" style={{ background: statusColor(nextDue ? nextDue.days : 999) + "1A" }}>
                  <div className="text-[11px] text-white uppercase tracking-wide mb-1 font-mono">Next up</div>
                  <div className="text-sm font-semibold" style={{ color: statusColor(nextDue ? nextDue.days : 999) }}>
                    {dueText(nextDue)}
                  </div>
                </div>

                <div>
                  <div className="text-[12px] font-semibold text-white mb-2">Remind me this many days before</div>
                  <div className="flex flex-wrap gap-2">
                    {leadOptions.map((d) => (
                      <button
                        key={d}
                        onClick={() => setLeadDays(d)}
                        className="px-3 py-1.5 rounded-full text-sm font-mono border transition-colors"
                        style={
                          leadDays === d
                            ? { background: "#FFFFFF", color: "#0E0F11", borderColor: "#FFFFFF" }
                            : { background: "transparent", color: "#FFFFFF", borderColor: "#2A2B30" }
                        }
                      >
                        {d}d
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="text-[12px] font-semibold text-white mb-2">Browser notifications</div>
                  {permission === "granted" ? (
                    <button
                      onClick={() => setNotifyEnabled((v) => !v)}
                      className="w-full flex items-center justify-between border border-[#2A2B30] rounded-lg px-4 py-3"
                    >
                      <span className="flex items-center gap-2 text-sm text-white">
                        {notifyEnabled ? <BellRing size={16} color="#37C9A6" /> : <BellOff size={16} color="#FFFFFF" />}
                        {notifyEnabled ? "Alerts on" : "Alerts off"}
                      </span>
                      <span
                        className="w-10 h-6 rounded-full relative transition-colors"
                        style={{ background: notifyEnabled ? "var(--accent-mid)" : "#2A2B30" }}
                      >
                        <span
                          className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
                          style={{ left: notifyEnabled ? "18px" : "2px" }}
                        />
                      </span>
                    </button>
                  ) : permission === "unsupported" ? (
                    <p className="text-sm text-white">
                      This browser doesn't support notifications. You'll still see the alert banner in the app.
                    </p>
                  ) : (
                    <button
                      onClick={requestNotifications}
                      className="w-full chrome-btn font-semibold rounded-md py-2.5 text-sm flex items-center justify-center gap-2"
                    >
                      <Bell size={16} /> Enable browser notifications
                    </button>
                  )}
                  {permission === "denied" && (
                    <p className="text-[12px] text-white mt-2">
                      Notifications are blocked for this page. Allow them in your browser's site settings to enable alerts.
                    </p>
                  )}
                  <p className="text-[11px] text-white mt-3">
                    Notifications only fire while this app is open in your browser. The in-app banner on the menu page always shows the latest reminder regardless.
                  </p>
                </div>

                <div>
                  <div className="text-[12px] font-semibold text-white mb-2">Phone notifications (even when the app's closed)</div>
                  {pushSubscribed ? (
                    <div className="flex items-center gap-2 text-sm text-[#37C9A6] border border-[#2A2B30] rounded-lg px-4 py-3">
                      <BellRing size={16} /> Enabled — you'll get a real notification on this phone
                    </div>
                  ) : (
                    <button
                      onClick={enablePhonePush}
                      disabled={pushBusy}
                      className="w-full chrome-btn font-semibold rounded-md py-2.5 text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                      {pushBusy ? <Loader2 size={16} className="animate-spin" /> : <Bell size={16} />}
                      {pushBusy ? "Enabling…" : "Enable phone notifications"}
                    </button>
                  )}
                  {pushError && (
                    <div className="flex items-start gap-2 text-[12px] text-[#F2A93B] mt-2">
                      <AlertCircle size={14} className="shrink-0 mt-0.5" />
                      <span>{pushError}</span>
                    </div>
                  )}
                  <p className="text-[11px] text-white mt-3">
                    Sends a real notification to your phone the moment something's due — no need to have the app open. On iPhone, this only works if you've added the app to your Home Screen first (Share → Add to Home Screen) and opened it from there. Only works on the deployed version of this app, not in the Claude preview — see the README for setup.
                  </p>
                </div>
              </div>
            )}

            {section === "customize" && (
              <div className="border border-[#2A2B30] rounded-2xl p-5"
                style={{ background: "var(--panel-tint)" }}
              >
                <p className="text-[13px] text-white mb-4">
                  Choose an accent colour for buttons and highlights throughout the app.
                </p>
                <div className="grid grid-cols-3 gap-3">
                  {Object.entries(THEMES).map(([key, t]) => (
                    <button
                      key={key}
                      onClick={() => { setAccentTheme(key); storageSet("theme", key); }}
                      className="flex flex-col items-center gap-2 rounded-xl p-3 border transition-colors"
                      style={{ borderColor: accentTheme === key ? t.mid : "#2A2B30", background: accentTheme === key ? t.mid + "14" : "transparent" }}
                    >
                      <span
                        className="w-10 h-10 rounded-full flex items-center justify-center"
                        style={{ background: `linear-gradient(160deg, ${t.light} 0%, ${t.mid} 40%, ${t.dark} 60%, ${t.light} 100%)` }}
                      >
                        {accentTheme === key && <Check size={16} color="#0E0F11" />}
                      </span>
                      <span className="text-[12px] text-white font-medium">{t.name}</span>
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-white opacity-60 mt-4">
                  Applies instantly and saves automatically — no need to hit Save. This retints the background, every card, buttons, and the notification toggle; the logo badge and green/amber/red due-date colours stay the same everywhere, since those carry specific meaning.
                </p>
              </div>
            )}
          </div>
        )}
      </main>

      <footer className="max-w-2xl mx-auto px-5 pb-8 text-[11px] text-white font-mono">
        Data resets on refresh — this is a working demo.
      </footer>

      {modal === "reminders" && (
        <Modal title={editingId ? "Edit service reminder" : "New service reminder"} onClose={() => { setModal(null); setEditingId(null); setForm({}); }}>
          <label className="block text-[12px] font-semibold text-white mb-1.5">Task</label>
          <AutocompleteInput
            placeholder="e.g. Oil change"
            value={form.task || ""}
            options={SERVICE_TASKS}
            onChange={(val) => setForm({ ...form, task: val })}
          />
          <label className="block text-[12px] font-semibold text-white mb-1.5">Due date</label>
          <FormInput type="date" value={form.dueDate || ""} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
          <label className="block text-[12px] font-semibold text-white mb-1.5">Due mileage (optional)</label>
          <FormInput type="number" placeholder="e.g. 45000" value={form.mileage || ""} onChange={(e) => setForm({ ...form, mileage: e.target.value })} />
          <button onClick={addReminder} className="w-full chrome-btn font-semibold rounded-md py-2 text-sm">{editingId ? "Save changes" : "Add reminder"}</button>
        </Modal>
      )}
      {modal === "mot" && (
        <Modal title="Update MOT expiry" onClose={() => setModal(null)}>
          <label className="block text-[12px] font-semibold text-white mb-1.5">Expiry date</label>
          <FormInput type="date" defaultValue={mot.expiry || ""} onChange={(e) => setForm({ ...form, expiry: e.target.value })} />
          <button onClick={() => { if (form.expiry) setMot({ expiry: form.expiry }); setForm({}); setModal(null); }} className="w-full chrome-btn font-semibold rounded-md py-2 text-sm">Save</button>
        </Modal>
      )}
      {modal === "insurance" && (
        <Modal title="Update insurance" onClose={() => setModal(null)}>
          <label className="block text-[12px] font-semibold text-white mb-1.5">Provider</label>
          <AutocompleteInput
            placeholder="e.g. Aviva"
            value={form.provider !== undefined ? form.provider : insurance.provider}
            options={INSURANCE_PROVIDERS}
            onChange={(val) => setForm({ ...form, provider: val })}
          />
          <label className="block text-[12px] font-semibold text-white mb-1.5">Annual premium (£)</label>
          <FormInput type="number" placeholder="e.g. 620" defaultValue={insurance.premium || ""} onChange={(e) => setForm({ ...form, premium: e.target.value })} />
          <label className="block text-[12px] font-semibold text-white mb-1.5">Renewal date</label>
          <FormInput type="date" defaultValue={insurance.renewal || ""} onChange={(e) => setForm({ ...form, renewal: e.target.value })} />
          <button
            onClick={() => {
              setInsurance({
                provider: form.provider || insurance.provider,
                premium: form.premium || insurance.premium,
                renewal: form.renewal || insurance.renewal,
              });
              setForm({}); setModal(null);
            }}
            className="w-full chrome-btn font-semibold rounded-md py-2 text-sm"
          >
            Save
          </button>
        </Modal>
      )}
      {modal === "roadtax" && (
        <Modal title="Update road tax" onClose={() => setModal(null)}>
          <label className="block text-[12px] font-semibold text-white mb-1.5">Renewal date</label>
          <FormInput type="date" defaultValue={roadTax.renewal || ""} onChange={(e) => setForm({ ...form, renewal: e.target.value })} />
          <label className="block text-[12px] font-semibold text-white mb-1.5">Annual cost (£, optional)</label>
          <FormInput type="number" placeholder="e.g. 180" defaultValue={roadTax.cost || ""} onChange={(e) => setForm({ ...form, cost: e.target.value })} />
          <button
            onClick={() => {
              if (form.renewal) setRoadTax({ renewal: form.renewal, cost: form.cost || roadTax.cost || "" });
              setForm({}); setModal(null);
            }}
            className="w-full chrome-btn font-semibold rounded-md py-2 text-sm"
          >
            Save
          </button>
        </Modal>
      )}
      {modal === "fuel" && (
        <Modal title={editingId ? "Edit entry" : "Log fuel / charging"} onClose={() => { setModal(null); setEditingId(null); setForm({}); }}>
          <label className="block text-[12px] font-semibold text-white mb-1.5">Date</label>
          <FormInput type="date" value={form.date || ""} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          <label className="block text-[12px] font-semibold text-white mb-1.5">Cost (£)</label>
          <FormInput type="number" placeholder="e.g. 62" value={form.cost || ""} onChange={(e) => setForm({ ...form, cost: e.target.value })} />
          <button onClick={addFuel} className="w-full bg-[#D9A45B] text-black font-semibold rounded-md py-2 text-sm">{editingId ? "Save changes" : "Add entry"}</button>
        </Modal>
      )}
      {modal === "repairs" && (
        <Modal title={editingId ? "Edit repair" : "Log a repair"} onClose={() => { setModal(null); setEditingId(null); setForm({}); }}>
          <label className="block text-[12px] font-semibold text-white mb-1.5">Date</label>
          <FormInput type="date" value={form.date || ""} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          <label className="block text-[12px] font-semibold text-white mb-1.5">Description</label>
          <AutocompleteInput
            placeholder="e.g. Front tyres replaced"
            value={form.desc || ""}
            options={REPAIR_DESCRIPTIONS}
            onChange={(val) => setForm({ ...form, desc: val })}
          />
          <label className="block text-[12px] font-semibold text-white mb-1.5">Cost (£)</label>
          <FormInput type="number" placeholder="e.g. 240" value={form.cost || ""} onChange={(e) => setForm({ ...form, cost: e.target.value })} />
          <button onClick={addRepair} className="w-full bg-[#9A9DA2] text-black font-semibold rounded-md py-2 text-sm">{editingId ? "Save changes" : "Add repair"}</button>
        </Modal>
      )}
      {modal === "documents" && (
        <Modal title="Upload a document" onClose={() => setModal(null)}>
          <label className="flex flex-col items-center justify-center gap-2 border border-dashed border-[#2A2B30] rounded-lg py-8 px-4 mb-3 cursor-pointer hover:border-[#8FA3B0] transition-colors">
            <FileText size={22} color="#8FA3B0" />
            <span className="text-sm text-white text-center">Tap to choose a file<br /><span className="text-[12px] text-white">PDF, image, or document</span></span>
            <input type="file" multiple className="hidden" onChange={(e) => uploadDocuments(e.target.files)} />
          </label>
        </Modal>
      )}
    </div>
  );
}
