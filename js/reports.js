import { formatReadable, dateKeyFromWall, getTodayKey, formatDateDDMMYYYY } from './utils.js';
import { getDB, ensureDayShape, blankDay } from './storage.js';
import { computeStreak, SUBJECT_COLORS } from './charts.js';
// Forward references — ui.js, firebase-sync.js land in later steps. Only
// called inside function bodies, safe once the full module graph is wired
// in main.js.
import { showToast } from './ui.js';
import { getCurrentUser } from './firebase-sync.js';

export 
    function buildShareText(dt) {
        let db = getDB(); let day = db[dt];
        if (!day) return `No study data logged for ${formatDateDDMMYYYY(dt)}.`;
        ensureDayShape(day);
        let lines = [`📚 Study Log — ${formatDateDDMMYYYY(dt)}`, `⏱ Total Study: ${formatReadable(day.totalStudy)}`, `☕ Total Break: ${formatReadable(day.totalBreak)}`, ``];
        lines.push(`Subject breakdown:`);
        for (let [cat, sec] of Object.entries(day.subjects)) if (sec > 0) lines.push(`• ${cat}: ${formatReadable(sec)}`);
        lines.push(``, `🧮 Questions Solved: ${day.questionsSolved || 0}`);
        lines.push(``, `Tracked with @ẞhì's JEE Study Tracker 🎯`);
        return lines.join("\n");
    }

export 
function buildShareCanvas(dt) {
    let db = getDB(); 
    let day = db[dt] || blankDay(); 
    ensureDayShape(day);
    
    let entries = Object.entries(day.subjects).filter(([, sec]) => sec > 0);
    let totalSubjectSec = entries.reduce((sum, [, sec]) => sum + sec, 0);
    let hasData = entries.length > 0 && totalSubjectSec > 0;
    
    // Canvas dimensions - calculated dynamically
    let width = 720;
    let legendItemHeight = 32;
    let legendHeight = hasData ? (entries.length * legendItemHeight + 30) : 60;
    // legendSectionYPrecalc mirrors chartTopY(245) + chartHeight(200) + 20
    // = 465, the same constants used further down when the donut chart is
    // drawn (kept as a separate name from the later legendSectionY so both
    // declarations coexist in this scope) — computed here purely so the
    // extra "Questions Solved" block below can reserve its own space
    // up front, before canvas.height is set.
    let legendSectionYPrecalc = 465;
    let qDividerY = legendSectionYPrecalc + legendHeight - 5;
    let qLabelY = qDividerY + 30;
    let footerY = qLabelY + 38;
    let height = footerY + 22; // title + stats + chart + legend + questions solved + footer

    let canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    let ctx = canvas.getContext("2d");
    
    // Background and border
    ctx.fillStyle = "#090d16";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#232f48";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, width - 2, height - 2);
    
    // ============= TITLE SECTION =============
    ctx.textAlign = "center";
    ctx.fillStyle = "#38bdf8";
    ctx.font = "bold 28px sans-serif";
    ctx.fillText("🎯 JEE Study Log", width / 2, 52);
    
    ctx.fillStyle = "#64748b";
    ctx.font = "16px sans-serif";
    ctx.fillText(dt, width / 2, 80);
    ctx.textAlign = "left"; // Reset alignment so the rest of the canvas stays perfectly unchanged
    
    // ============= HORIZONTAL SEPARATOR 1 =============
    ctx.strokeStyle = "#232f48";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(32, 95);
    ctx.lineTo(width - 32, 95);
    ctx.stroke();
    
    // ============= TOP STATS ROW (Side-by-side with dynamic centering) =============
    let statsY = 155;
    
    // LEFT STAT: Total Study Time
    ctx.fillStyle = "#10b981";
    ctx.font = "bold 48px sans-serif";
    ctx.textAlign = "center";
    let studyTimeText = formatReadable(day.totalStudy);
    let leftStatCenterX = width / 4; // Center in left quarter
    ctx.fillText(studyTimeText, leftStatCenterX, statsY);
    
    ctx.fillStyle = "#64748b";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("TOTAL STUDY TIME", leftStatCenterX, statsY + 35);
    
    // RIGHT STAT: Total Break Time
    ctx.fillStyle = "#a78bfa";
    ctx.font = "bold 48px sans-serif";
    ctx.textAlign = "center";
    let breakTimeText = formatReadable(day.totalBreak);
    let rightStatCenterX = (3 * width) / 4; // Center in right quarter
    ctx.fillText(breakTimeText, rightStatCenterX, statsY);
    
    ctx.fillStyle = "#64748b";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("TOTAL BREAK TIME", rightStatCenterX, statsY + 35);
    
    // ============= HORIZONTAL SEPARATOR 2 =============
    ctx.strokeStyle = "#232f48";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(32, 215);
    ctx.lineTo(width - 32, 215);
    ctx.stroke();
    
    // ============= SECTION TITLE =============
    ctx.fillStyle = "#f1f5f9";
    ctx.font = "bold 16px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("SUBJECT-WISE STUDY TIME", 32, 245);
    
    // ============= DONUT CHART =============
    let chartTopY = 245;
    let chartHeight = 200;
    let cx = width / 2; // Perfect horizontal center
    let cy = chartTopY + chartHeight / 2; // Perfect vertical center
    let outerRadius = 90;
    let innerRadius = 50; // Donut hole
    
    if (hasData) {
        let startAngle = -Math.PI / 2;
        entries.forEach(([cat, sec]) => {
            let sliceAngle = (sec / totalSubjectSec) * Math.PI * 2;
            let endAngle = startAngle + sliceAngle;
            
            // Draw donut slice
            ctx.beginPath();
            ctx.arc(cx, cy, outerRadius, startAngle, endAngle);
            ctx.lineTo(
                cx + innerRadius * Math.cos(endAngle),
                cy + innerRadius * Math.sin(endAngle)
            );
            ctx.arc(cx, cy, innerRadius, endAngle, startAngle, true);
            ctx.closePath();
            
            ctx.fillStyle = SUBJECT_COLORS[cat] || "#64748b";
            ctx.fill();
            
            startAngle = endAngle;
        });
        
        // Center text in donut hole
        ctx.fillStyle = "#f1f5f9";
        ctx.font = "bold 16px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(formatReadable(totalSubjectSec), cx, cy);
    } else {
        // Empty state: gray donut
        ctx.beginPath();
        ctx.arc(cx, cy, outerRadius, 0, Math.PI * 2);
        ctx.lineTo(cx + innerRadius, cy);
        ctx.arc(cx, cy, innerRadius, 0, Math.PI * 2, true);
        ctx.closePath();
        ctx.fillStyle = "#232f48";
        ctx.fill();
        
        ctx.fillStyle = "#64748b";
        ctx.font = "bold 16px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("0h 0m 0s", cx, cy);
    }
    
    // ============= HORIZONTAL SEPARATOR 3 (before legend) =============
    let legendSectionY = chartTopY + chartHeight + 20;
    ctx.strokeStyle = "#232f48";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(32, legendSectionY);
    ctx.lineTo(width - 32, legendSectionY);
    ctx.stroke();
    
    // ============= LEGEND =============
    let legendY = legendSectionY + 25;
    ctx.textBaseline = "middle";
    
    if (hasData) {
        entries.forEach(([cat, sec]) => {
            let color = SUBJECT_COLORS[cat] || "#64748b";
            
            // Color square icon
            ctx.fillStyle = color;
            ctx.fillRect(32, legendY - 8, 14, 14);
            
            // Subject name (left-aligned)
            ctx.fillStyle = "#f1f5f9";
            ctx.font = "16px sans-serif";
            ctx.textAlign = "left";
            ctx.fillText(cat, 56, legendY);
            
            // Time value (right-aligned, in subject's color)
            ctx.fillStyle = color;
            ctx.font = "bold 16px sans-serif";
            ctx.textAlign = "right";
            ctx.fillText(formatReadable(sec), width - 32, legendY);
            
            legendY += legendItemHeight;
        });
    } else {
        ctx.fillStyle = "#64748b";
        ctx.font = "14px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText("No subject-wise study time logged.", 32, legendY);
    }
    
    // ============= QUESTIONS SOLVED =============
    ctx.strokeStyle = "#232f48";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(32, qDividerY);
    ctx.lineTo(width - 32, qDividerY);
    ctx.stroke();

    ctx.fillStyle = "#38bdf8";
    ctx.font = "bold 18px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(`🧮 Questions Solved: ${day.questionsSolved || 0}`, 32, qLabelY);

    // ============= FOOTER =============
    // Centered, matching the weekly/monthly report's footer style.
    ctx.fillStyle = "#64748b";
    ctx.font = "16px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Made with ❤️ by @ẞhì's JEE Study Tracker", width / 2, footerY);

    return canvas;
}

export function downloadDayLog() {
        let dt = document.getElementById("history-picker").value; if (!dt) return;
        let canvas = buildShareCanvas(dt);
        canvas.toBlob((blob) => { let url = URL.createObjectURL(blob); let a = document.createElement("a"); a.href = url; a.download = `study-log-${dt}.png`; a.click(); URL.revokeObjectURL(url); showToast("Log downloaded."); });
    }

export async function shareDayLog() {
        let dt = document.getElementById("history-picker").value; if (!dt) return;
        let text = buildShareText(dt); let canvas = buildShareCanvas(dt);
        canvas.toBlob(async (blob) => {
            let file = new File([blob], `study-log-${dt}.png`, { type: "image/png" });
            if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: "My Study Log", text }); return; } catch (e) { if (e.name === "AbortError") return; } }
            if (navigator.share) { try { await navigator.share({ title: "My Study Log", text }); return; } catch (e) { if (e.name === "AbortError") return; } }
            let url = URL.createObjectURL(blob); let a = document.createElement("a"); a.href = url; a.download = `study-log-${dt}.png`; a.click(); URL.revokeObjectURL(url);
            try { await navigator.clipboard.writeText(text); showToast("Image downloaded & summary copied!"); } catch (e) { showToast("Image downloaded!"); }
        }, "image/png");
    }

// ---------------- CLOUDFLARE WORKER EMAIL ----------------
const WORKER_URL = "https://api.jeestudytracker.workers.dev";
const ALLOWED_EMAIL_DOMAINS = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com'];

export async function sendReportViaEmail(type, silent = false) {
        let emailInput = null;
        let manuallyTriggered = !silent;

        // If manually triggered, prompt for email (optional)
        if (manuallyTriggered) {
            let userEmail = prompt("Enter email to send to OR (leave blank & click ok for signed-in email):");
            // prompt() returns null on Cancel, but "" (empty string) on OK
            // with a blank field — those are NOT the same thing. Only a
            // blank OK should fall through to the signed-in email below;
            // Cancel must abort the send entirely.
            if (userEmail === null) return;
            if (userEmail.trim() !== "") {
               let domain = userEmail.split('@')[1];
if (!domain || !ALLOWED_EMAIL_DOMAINS.includes(domain.toLowerCase())) {
    if (manuallyTriggered) {
        alert("To save quota, this app only sends to Gmail, Yahoo, Outlook, or Hotmail. Please sign in with a valid email.");
        return;
    }
    // If auto-send and domain is invalid, we silently skip to avoid breaking automation
    return;
}
                emailInput = userEmail.trim();
            }
        }

        // If no manual email, use signed-in user's email
        if (!emailInput) {
            if (!getCurrentUser()) {
                if (manuallyTriggered) alert("You must be signed in with Google to email the report.");
                return;
            }
            emailInput = getCurrentUser().email;
            if (!emailInput) {
                if (manuallyTriggered) alert("Your Google account does not have an email associated.");
                return;
            }
            let domain = emailInput.split('@')[1];
            if (!domain || !ALLOWED_EMAIL_DOMAINS.includes(domain.toLowerCase())) {
                if (manuallyTriggered) alert("To save quota, this app only sends to Gmail, Yahoo, Outlook, or Hotmail. Please sign in with a valid email.");
                return;
            }
        }

        // Generate report data. 'daily' reuses the single History-picker
        // date (same source as Share Log / Download Log); weekly/monthly
        // aggregate a date range exactly as before.
        let db = getDB();
        let days, totalStudy, totalBreak, aggregateSubjects, canvas, dateRangeLabel;
        if (type === 'daily') {
            let dt = document.getElementById("history-picker").value || getTodayKey();
            let day = db[dt] || blankDay();
            ensureDayShape(day);
            totalStudy = day.totalStudy || 0;
            totalBreak = day.totalBreak || 0;
            aggregateSubjects = { ...day.subjects };
            days = [dt];
            dateRangeLabel = dt;
            canvas = buildShareCanvas(dt);
        } else {
            let today = new Date(); let range = (type === 'weekly') ? 6 : 29;
            days = [];
            for (let i = range; i >= 0; i--) { let d = new Date(today); d.setDate(today.getDate() - i); days.push(dateKeyFromWall(d.getTime())); }
            totalStudy = 0; totalBreak = 0;
            aggregateSubjects = { "Physics": 0, "Organic Chemistry": 0, "Inorganic Chemistry": 0, "Physical Chemistry": 0, "Mathematics": 0, "Revision": 0, "School Preparation": 0, "Mock Test / Analysis": 0 };
            days.forEach(key => { let day = db[key]; if (!day) return; ensureDayShape(day); totalStudy += day.totalStudy || 0; totalBreak += day.totalBreak || 0; for (let [cat, sec] of Object.entries(day.subjects)) { aggregateSubjects[cat] = (aggregateSubjects[cat] || 0) + (sec || 0); } });
            dateRangeLabel = `${days[0]} → ${days[days.length - 1]}`;
            canvas = buildReportCanvas(days, type === 'weekly' ? 'Weekly Study Report' : 'Monthly Study Report');
        }
        let subjectHtml = "";
        for (let [cat, sec] of Object.entries(aggregateSubjects)) { if (sec <= 0) continue; subjectHtml += `<div style="display: flex; justify-content: space-between; padding: 8px 16px; border-bottom: 1px solid #1e293b; font-size: 14px;"><span style="color: #94a3b8;">${cat}:&nbsp;</span><span style="color: #38bdf8; font-weight: 600;">${formatReadable(sec)}</span></div>`; }
        if (!subjectHtml) subjectHtml = "<div style='padding: 12px; color: #64748b; text-align:center;'>No study time logged.</div>";
        let imageBlob = await new Promise(resolve => canvas.toBlob(resolve));
        let reader = new FileReader(); 
        reader.readAsDataURL(imageBlob);
        reader.onloadend = async function() {
            let base64Image = reader.result;
            let cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, '');
            try {
                let response = await fetch(WORKER_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        to_email: emailInput,
                        report_type: type === 'weekly' ? 'Weekly' : (type === 'monthly' ? 'Monthly' : 'Daily'),
                        date_range: dateRangeLabel,
                        total_study: formatReadable(totalStudy),
                        total_break: formatReadable(totalBreak),
                        streak: computeStreak(db),
                        subject_list_html: subjectHtml,
                        report_image: cleanBase64
                    })
                });

                if (response.ok) {
                    showToast(`Report sent successfully to ${emailInput}!`);
                } else {
                    const errorText = await response.text();
                    if (silent) { showToast(`⚠️ Auto-email of the ${type} report failed — will retry next cycle.`); }
                    else { alert("Email send failed: " + errorText); }
                }
            } catch (e) {
                if (silent) { showToast(`⚠️ Auto-email of the ${type} report failed — will retry next cycle.`); }
                else { alert("Email send failed: " + e.message); }
            }
        };
    }

export 
function buildReportCanvas(days, title) {
    let db = getDB();
    let totalStudy = 0, totalBreak = 0;
    let aggregateSubjects = { "Physics": 0, "Organic Chemistry": 0, "Inorganic Chemistry": 0, "Physical Chemistry": 0, "Mathematics": 0, "Revision": 0, "School Preparation": 0, "Mock Test / Analysis": 0 };
    let dayData = [];
    days.forEach(key => {
        let day = db[key];
        if (!day) return;
        ensureDayShape(day);
        totalStudy += day.totalStudy || 0;
        totalBreak += day.totalBreak || 0;
        for (let [cat, sec] of Object.entries(day.subjects)) { aggregateSubjects[cat] = (aggregateSubjects[cat] || 0) + (sec || 0); }
        dayData.push({ date: key, study: day.totalStudy || 0, break: day.totalBreak || 0, questions: day.questionsSolved || 0 });
    });
    let entries = Object.entries(aggregateSubjects).filter(([, sec]) => sec > 0);
    let totalSubjectSec = entries.reduce((sum, [, sec]) => sum + sec, 0);
    let hasData = entries.length > 0 && totalSubjectSec > 0;

    const width = 1200;
    const leftHalfCenter = 300;    // midpoint of the 0–600 left half
    const rightHalfCenter = 900;   // midpoint of the 600–1200 right half

    // ---- Fixed Y positions above the table ----
    const titleY = 80;
    const subtitleY = 130;
    const statsNumberY = 240;
    const statsLabelY = 278;
    const sectionTitleY = 360;
    const heatmapDowY = sectionTitleY + 34;
    const heatmapGridStartY = heatmapDowY + 16;
    const cellSize = 27, cellGap = 7;
    const heatmapWidth = 7 * cellSize + 6 * cellGap;          // 190px
    const heatmapX = leftHalfCenter - heatmapWidth / 2;        // centered in left half
    const heatmapRows = Math.ceil(Math.min(dayData.length, 35) / 7);
    const heatmapBottomY = heatmapGridStartY + heatmapRows * (cellSize + cellGap);
    // Color-key row (study-hours buckets) drawn just under the heatmap grid,
    // so a shared/downloaded report is self-explanatory without the live app.
    const heatmapLegendY = heatmapBottomY + 44;
    const heatmapLegendBottomY = heatmapLegendY + 16;

    const pieCx = rightHalfCenter, pieRadius = 100;            // centered in right half
    const pieCy = sectionTitleY + 40 + pieRadius;
    const pieBottomY = pieCy + pieRadius;

    const tableTitleY = Math.max(heatmapLegendBottomY, pieBottomY) + 55;
    const tableHeaderY = tableTitleY + 45;
    const tableDividerY = tableHeaderY + 15;
    const tableFirstRowY = tableDividerY + 30;
    const rowH = 30;

    const rowsPerColumn = Math.ceil(dayData.length / 2);
    const tableBottomY = tableFirstRowY + rowsPerColumn * rowH;
    const footerY = tableBottomY + 60;
    const height = footerY + 30;

    let canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    let ctx = canvas.getContext("2d");
    ctx.fillStyle = "#090d16"; ctx.fillRect(0, 0, width, height);

    // ---- Title ----
    ctx.fillStyle = "#38bdf8"; ctx.font = "bold 48px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(title, width / 2, titleY);
    ctx.fillStyle = "#64748b"; ctx.font = "26px sans-serif";
    ctx.fillText(`${days.length} Days | ${days[0]} → ${days[days.length - 1]}`, width / 2, subtitleY);

// ---- Stats row (true equal gaps, computed from actual rendered text width) ----
const study = formatReadable(totalStudy);
const brk = formatReadable(totalBreak);
const streak = `🔥 ${computeStreak(db)}`;

ctx.font = "bold 64px sans-serif";
const wStudy = ctx.measureText(study).width;
const wBreak = ctx.measureText(brk).width;
const wStreak = ctx.measureText(streak).width;

const gap = (width - (wStudy + wBreak + wStreak)) / 4; // left margin, 2 inner gaps, right margin — all equal

const xStudy = gap + wStudy / 2;
const xBreak = gap + wStudy + gap + wBreak / 2;
const xStreak = gap + wStudy + gap + wBreak + gap + wStreak / 2;

ctx.textAlign = "center";
ctx.fillStyle = "#10b981"; ctx.fillText(study, xStudy, statsNumberY);
ctx.fillStyle = "#64748b"; ctx.font = "22px sans-serif"; ctx.fillText("Total Study", xStudy, statsLabelY);

ctx.fillStyle = "#a78bfa"; ctx.font = "bold 64px sans-serif"; ctx.fillText(brk, xBreak, statsNumberY);
ctx.fillStyle = "#64748b"; ctx.font = "22px sans-serif"; ctx.fillText("Total Break", xBreak, statsLabelY);

ctx.fillStyle = "#f59e0b"; ctx.font = "bold 64px sans-serif"; ctx.fillText(streak, xStreak, statsNumberY);
ctx.fillStyle = "#64748b"; ctx.font = "22px sans-serif"; ctx.fillText("Streak (days)", xStreak, statsLabelY);
ctx.textAlign = "left";

    // ---- Study Heatmap (centered in left half) ----
    ctx.fillStyle = "#f1f5f9"; ctx.font = "bold 22px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Study Heatmap", leftHalfCenter, sectionTitleY);
    // BUG FIX: this canvas heatmap had drifted out of sync with charts.js's
    // renderHeatmap() — it was still on an older multi-hue (blue/green/
    // amber/rose) scale instead of the single-hue palette the live in-app
    // heatmap uses, so a downloaded/shared report looked visibly different
    // from what the app itself shows. Now uses the same 5-step palette
    // (and matching per-bucket stroke colors instead of one flat outline)
    // as charts.js's hmColors/hmStrokes, so the report image always
    // matches the live heatmap.
    const hmColors = ["#233252", "#2c5a9e", "#3a91c9", "#5cc0e8", "#a3e0f8"];
    const hmStrokes = ["#1f2e4a", "#2e5d8e", "#4194c3", "#62c4e6", "#a6e3fa"];
    const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    ctx.fillStyle = "#64748b"; ctx.font = "12px sans-serif";
    for (let j = 0; j < 7; j++) { ctx.fillText(dow[j], heatmapX + 11 + j * (cellSize + cellGap), heatmapDowY); }
    ctx.textAlign = "left";
    dayData.slice(0, 35).forEach((d, i) => {
        let hrs = d.study / 3600; let colorIdx = 0;
        if (hrs > 0) colorIdx = 1; if (hrs > 3) colorIdx = 2; if (hrs > 6) colorIdx = 3; if (hrs >= 10) colorIdx = 4;
        let dayDate = new Date(d.date + "T00:00:00"); let col = dayDate.getDay(); let adjustedCol = col === 0 ? 6 : col - 1;
        let row = Math.floor(i / 7);
        let x = heatmapX + adjustedCol * (cellSize + cellGap);
        let y = heatmapGridStartY + row * (cellSize + cellGap);
        ctx.fillStyle = hmColors[colorIdx]; ctx.fillRect(x, y, cellSize, cellSize);
        ctx.strokeStyle = hmStrokes[colorIdx]; ctx.strokeRect(x, y, cellSize, cellSize);
    });

    // ---- Heatmap color key (0h / 0–3h / 3–6h / 6–10h / 10h+) ----
    // Centered as one block under the heatmap so it reads as a caption,
    // not a separate section — same bucket thresholds as the coloring loop
    // just above (hrs>0 / >3 / >6 / >=10).
    const legendLabels = ["0h", "0–3h", "3–6h", "6–10h", "10h+"];
    const legendSwatch = 12, legendSwatchGap = 5, legendItemGap = 13;
    ctx.font = "12px sans-serif";
    const legendItemWidths = legendLabels.map(l => legendSwatch + legendSwatchGap + ctx.measureText(l).width);
    const legendTotalWidth = legendItemWidths.reduce((a, b) => a + b, 0) + legendItemGap * (legendLabels.length - 1);
    let legendX = leftHalfCenter - legendTotalWidth / 2;
    ctx.textBaseline = "middle";
    legendLabels.forEach((label, idx) => {
        ctx.fillStyle = hmColors[idx];
        ctx.fillRect(legendX, heatmapLegendY - legendSwatch / 2, legendSwatch, legendSwatch);
        ctx.strokeStyle = hmStrokes[idx];
        ctx.strokeRect(legendX, heatmapLegendY - legendSwatch / 2, legendSwatch, legendSwatch);
        ctx.fillStyle = "#94a3b8";
        ctx.textAlign = "left";
        ctx.fillText(label, legendX + legendSwatch + legendSwatchGap, heatmapLegendY + 1);
        legendX += legendItemWidths[idx] + legendItemGap;
    });
    ctx.textBaseline = "alphabetic";

    // ---- Subject Breakdown pie (centered in right half) ----
    ctx.fillStyle = "#f1f5f9"; ctx.font = "bold 22px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Subject Breakdown", rightHalfCenter, sectionTitleY);
    if (hasData) {
        let startAngle = -Math.PI / 2;
        entries.forEach(([cat, sec]) => {
            let sliceAngle = (sec / totalSubjectSec) * Math.PI * 2;
            ctx.beginPath(); ctx.moveTo(pieCx, pieCy); ctx.arc(pieCx, pieCy, pieRadius, startAngle, startAngle + sliceAngle); ctx.closePath();
            ctx.fillStyle = SUBJECT_COLORS[cat] || "#64748b"; ctx.fill(); startAngle += sliceAngle;
        });
        ctx.beginPath(); ctx.arc(pieCx, pieCy, 60, 0, Math.PI * 2); ctx.fillStyle = "#090d16"; ctx.fill();
        ctx.fillStyle = "#f1f5f9"; ctx.font = "bold 20px sans-serif";
        ctx.fillText(formatReadable(totalSubjectSec), pieCx, pieCy + 7);
    } else {
        ctx.beginPath(); ctx.arc(pieCx, pieCy, pieRadius, 0, Math.PI * 2); ctx.fillStyle = "#232f48"; ctx.fill();
        ctx.beginPath(); ctx.arc(pieCx, pieCy, 60, 0, Math.PI * 2); ctx.fillStyle = "#090d16"; ctx.fill();
        ctx.fillStyle = "#64748b"; ctx.font = "20px sans-serif";
        ctx.fillText("No Data", pieCx, pieCy + 7);
    }
    ctx.textAlign = "left";

    // ---- Daily Performance Breakdown (2-column table, centered as a block) ----
    // Compute the table's horizontal layout dynamically so the two-column
    // block sits with equal margins left and right, instead of being
    // pinned to the left edge while empty space collects on the right.
    ctx.font = "16px sans-serif";
    const statusMaxWidth = Math.max(ctx.measureText("✅ Goal Met").width, ctx.measureText("❌ Missed").width);
    const colInnerGap = 100;   // date -> study -> break -> questions -> status spacing within one block
    const blockGap = 90;       // gap between the left block and the right block
    const blockContentWidth = 4 * colInnerGap + statusMaxWidth; // date..status offset + status text width
    const tableTotalWidth = blockContentWidth * 2 + blockGap;
    const tableLeftMargin = (width - tableTotalWidth) / 2;

    const colX = {
        left: { date: tableLeftMargin, study: tableLeftMargin + colInnerGap, break: tableLeftMargin + 2 * colInnerGap, questions: tableLeftMargin + 3 * colInnerGap, status: tableLeftMargin + 4 * colInnerGap },
        right: {}
    };
    colX.right = { date: colX.left.date + blockContentWidth + blockGap, study: colX.left.study + blockContentWidth + blockGap, break: colX.left.break + blockContentWidth + blockGap, questions: colX.left.questions + blockContentWidth + blockGap, status: colX.left.status + blockContentWidth + blockGap };

    ctx.fillStyle = "#f1f5f9"; ctx.font = "bold 22px sans-serif"; ctx.fillText("Daily Performance Breakdown", tableLeftMargin, tableTitleY);

    ctx.fillStyle = "#64748b"; ctx.font = "16px sans-serif";
    ctx.fillText("Date", colX.left.date, tableHeaderY); ctx.fillText("Study", colX.left.study, tableHeaderY); ctx.fillText("Break", colX.left.break, tableHeaderY); ctx.fillText("Questions", colX.left.questions, tableHeaderY); ctx.fillText("Status", colX.left.status, tableHeaderY);
    ctx.fillText("Date", colX.right.date, tableHeaderY); ctx.fillText("Study", colX.right.study, tableHeaderY); ctx.fillText("Break", colX.right.break, tableHeaderY); ctx.fillText("Questions", colX.right.questions, tableHeaderY); ctx.fillText("Status", colX.right.status, tableHeaderY);
    ctx.strokeStyle = "#232f48"; ctx.beginPath(); ctx.moveTo(tableLeftMargin, tableDividerY); ctx.lineTo(width - tableLeftMargin, tableDividerY); ctx.stroke();

    // BUG FIX: was filling row-major (alternating left/right by index parity —
    // item 10 left, 11 right, 12 left, 13 right...), which scatters a
    // logical run of dates across both columns out of vertical order.
    // Now fills column-major: the left column gets the first `rowsPerColumn`
    // entries top-to-bottom, then the right column continues with the rest —
    // so 10, 11, 12... read straight down one column before continuing.
    dayData.forEach((d, i) => {
        let col = (i < rowsPerColumn) ? colX.left : colX.right;
        let rowIdx = (i < rowsPerColumn) ? i : i - rowsPerColumn;
        let y = tableFirstRowY + rowIdx * rowH;
        ctx.fillStyle = "#f1f5f9"; ctx.font = "16px sans-serif"; ctx.fillText(d.date, col.date, y);
        ctx.fillStyle = "#10b981"; ctx.fillText(formatReadable(d.study), col.study, y);
        ctx.fillStyle = "#a78bfa"; ctx.fillText(formatReadable(d.break), col.break, y);
        ctx.fillStyle = "#38bdf8"; ctx.fillText(String(d.questions), col.questions, y);
        ctx.fillStyle = d.study >= 36000 ? "#10b981" : "#ef4444";
        ctx.fillText(d.study >= 36000 ? "✅ Goal Met" : "❌ Missed", col.status, y);
    });

    // ---- Footer ----
    ctx.fillStyle = "#64748b"; ctx.font = "20px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Made with ❤️ by @ẞhì", width / 2, footerY);

    return canvas;
}

function getReportDayRange(type) {
    let today = new Date();
    let days = [];
    let range = (type === 'weekly') ? 6 : 29;
    for (let i = range; i >= 0; i--) { let d = new Date(today); d.setDate(today.getDate() - i); days.push(dateKeyFromWall(d.getTime())); }
    return days;
}

export function downloadReport(type) {
        let days = getReportDayRange(type);
        let canvas = buildReportCanvas(days, type === 'weekly' ? '📊 Weekly Study Report' : '📊 Monthly Study Report');
        canvas.toBlob((blob) => { let url = URL.createObjectURL(blob); let a = document.createElement("a"); a.href = url; a.download = `report-${type}-${getTodayKey()}.png`; a.click(); URL.revokeObjectURL(url); showToast(`${type} report downloaded.`); });
    }

// Aggregated share text for a weekly/monthly report — mirrors buildShareText's
// style but sums across the whole date range instead of a single day.
function buildReportShareText(days, type) {
    let db = getDB();
    let totalStudy = 0, totalBreak = 0, totalQuestions = 0;
    let aggregateSubjects = { ...blankDay().subjects };
    days.forEach(key => {
        let day = db[key]; if (!day) return;
        ensureDayShape(day);
        totalStudy += day.totalStudy || 0;
        totalBreak += day.totalBreak || 0;
        totalQuestions += day.questionsSolved || 0;
        for (let [cat, sec] of Object.entries(day.subjects)) aggregateSubjects[cat] = (aggregateSubjects[cat] || 0) + (sec || 0);
    });
    let label = type === 'weekly' ? '📊 Weekly Study Report' : '📊 Monthly Study Report';
    let lines = [label, `🗓 ${days[0]} → ${days[days.length - 1]}`, `⏱ Total Study: ${formatReadable(totalStudy)}`, `☕ Total Break: ${formatReadable(totalBreak)}`, `🔥 Streak: ${computeStreak(db)} days`, `🧮 Total Questions Solved: ${totalQuestions}`, ``];
    lines.push(`Subject breakdown:`);
    for (let [cat, sec] of Object.entries(aggregateSubjects)) if (sec > 0) lines.push(`• ${cat}: ${formatReadable(sec)}`);
    lines.push(``, `Tracked with @ẞhì's JEE Study Tracker 🎯`);
    return lines.join("\n");
}

// Shares a weekly/monthly report the same way shareDayLog() shares a single
// day: native share sheet with the PNG + summary text when available,
// falling back to a download + clipboard copy.
export async function shareReport(type) {
        let days = getReportDayRange(type);
        let text = buildReportShareText(days, type);
        let canvas = buildReportCanvas(days, type === 'weekly' ? '📊 Weekly Study Report' : '📊 Monthly Study Report');
        canvas.toBlob(async (blob) => {
            let file = new File([blob], `report-${type}-${getTodayKey()}.png`, { type: "image/png" });
            if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: type === 'weekly' ? "My Weekly Study Report" : "My Monthly Study Report", text }); return; } catch (e) { if (e.name === "AbortError") return; } }
            if (navigator.share) { try { await navigator.share({ title: type === 'weekly' ? "My Weekly Study Report" : "My Monthly Study Report", text }); return; } catch (e) { if (e.name === "AbortError") return; } }
            let url = URL.createObjectURL(blob); let a = document.createElement("a"); a.href = url; a.download = `report-${type}-${getTodayKey()}.png`; a.click(); URL.revokeObjectURL(url);
            try { await navigator.clipboard.writeText(text); showToast("Image downloaded & summary copied!"); } catch (e) { showToast("Image downloaded!"); }
        }, "image/png");
    }

