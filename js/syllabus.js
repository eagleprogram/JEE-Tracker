import { escapeHtml } from './utils.js';
import { getSyllabusProgress, saveSyllabusProgress } from './storage.js';

// ----------------- SYLLABUS DATA -----------------
export const SYLLABUS_TAGS = ["Lectures", "Notes", "Revision", "HW", "DPP", "PYQ", "Question Practice", "Tests", "Mistakes"];

export const SYLLABUS_SUBJECTS = {
    "Physics": {
        11: ["Units & Dimensions","Basic Maths","Vectors","Kinematics 1D","Kinematics 2D","Laws of Motion (NLM)","Circular Motion","Work, Power & Energy","Centre of Mass (COM)","Thermal Properties of Matter","Mechanical Properties of Solids","Rotational Motion","KTG & Thermodynamics","Oscillations","Waves","Mechanical Properties of Fluids","Gravitation","Errors and Measurements"],
        12: ["Electrostatics","Electric Potential & Dipole & Conductor","Current Electricity","Capacitance","Semiconductors","Moving Charges & Magnetism","Magnetism & Matter","Electromagnetic Induction (EMI)","Alternating Current","Electromagnetic Waves","Ray Optics","Wave Optics","Dual Nature of Radiation & Matter","Atoms","Nuclei"]
    },
    "Maths": {
        11: ["Basic Maths","Sets","Trignometric Functions","Trignometric Equations","Quadratic Equations","Sequences & Series","Relations & Functions (XI)","Permutations & Combinations","Binomial Theorem","Limits & Derivatives","Linear Inequalities","Straight Lines","Circles","Parabola","Ellipse","Hyperbola","Probability (XI)","Introduction to 3D","Complex Numbers","Statistics","Solution of Triangles"],
        12: ["Determinants","Matrices","Relations & Functions (XII)","Inverse Trignometric Functions","Limits, Continuity and Differentiability","Method of Differentiation","Application of Derivatives","Indefinite Integration","Definite Integration","Application of Integrals","Differential Equations","Vector Algebra","3D Geometry (XII)","Probability (XII)","Linear Programming"]
    },
    "OC": {
        11: ["IUPAC Nomenclature","GOC","Isomerism","Purification & Analysis"],
        12: ["Optical Isomerism","Hydrocarbon","Haloalkanes & Haloarenes","Alcohols, Phenols and Ethers","Aldehydes/Ketones/Carboxylic Acids","Amines","Biomolecules","Polymers","Chemistry in Everyday Life","Environmental Chemistry"]
    },
    "IOC": {
        11: ["Periodic Table","Chemical Bonding","P Block (11th)","S Block","Hydrogen"],
        12: ["Coordination Compounds","P Block (12th)","D & F Block","Salt Analysis","Metallurgy"]
    },
    "PC": {
        11: ["Mole Concept","Structure of an Atom","States of Matter","Thermodynamics","Redox Reactions","Chemical Equilibrium","Ionic Equilibrium"],
        12: ["Solutions","Chemical Kinetics","Electrochemistry","Solid State","Surface Chemistry"]
    }
};

let activeSyllabusSubject = "Physics";
let expandedSyllabusChapters = {};

// ----------------- ONE-TIME CHAPTER-RENAME MIGRATION -----------------
// Progress is keyed by `subject|chapter name`. Several chapter names were
// renamed, added, or split just now (see the diff that produced this file).
// Without migrating, a rename would silently reset that chapter's tracked
// progress to 0% the next time it's rendered. Runs once per load; cheap,
// and a no-op once the old keys are gone.
export function migrateSyllabusChapterRenames() {
    let progress = getSyllabusProgress();
    let changed = false;

    function moveKey(oldKey, newKey) {
        if (!progress[oldKey]) return;
        if (!progress[newKey]) progress[newKey] = progress[oldKey];
        delete progress[oldKey];
        changed = true;
    }
    // Used where one old chapter split into two (or where two classes used
    // to collide on the same untagged chapter name): we can't know
    // retroactively which half the old progress belonged to, so copy it to
    // both as a starting point rather than lose it outright.
    function copyKeyToBoth(oldKey, newKeyA, newKeyB) {
        if (!progress[oldKey]) return;
        if (!progress[newKeyA]) progress[newKeyA] = { ...progress[oldKey] };
        if (!progress[newKeyB]) progress[newKeyB] = { ...progress[oldKey] };
        delete progress[oldKey];
        changed = true;
    }

    // Physics
    moveKey("Physics|Work Power & Energy", "Physics|Work, Power & Energy");
    moveKey("Physics|MP of Solids", "Physics|Mechanical Properties of Solids");
    moveKey("Physics|MP of Fluids", "Physics|Mechanical Properties of Fluids");
    moveKey("Physics|EMI", "Physics|Electromagnetic Induction (EMI)");
    moveKey("Physics|EM Waves", "Physics|Electromagnetic Waves");

    // Maths — class 11
    moveKey("Maths|Trig Functions", "Maths|Trignometric Functions");
    moveKey("Maths|Trig Equations", "Maths|Trignometric Equations");
    moveKey("Maths|P&C", "Maths|Permutations & Combinations");
    moveKey("Maths|Probability(XI)", "Maths|Probability (XI)");
    moveKey("Maths|Intro to 3D", "Maths|Introduction to 3D");
    moveKey("Maths|Relations & Functions (Part 1)", "Maths|Relations & Functions (XI)");

    // Maths — class 12
    moveKey("Maths|Relations & Functions (Part 2)", "Maths|Relations & Functions (XII)");
    moveKey("Maths|Inverse Trig Functions", "Maths|Inverse Trignometric Functions");
    moveKey("Maths|Limits/Continuity/Differentiability", "Maths|Limits, Continuity and Differentiability");
    moveKey("Maths|3D Geometry", "Maths|3D Geometry (XII)");
    moveKey("Maths|Probability", "Maths|Probability (XII)");

    // "Indefinite/Definite Integration" split into two separate chapters —
    // progress can't be split retroactively, so start both from the old state.
    copyKeyToBoth("Maths|Indefinite/Definite Integration", "Maths|Indefinite Integration", "Maths|Definite Integration");

    // Safety net: an even older version used the bare "Relations & Functions"
    // name for BOTH class 11 and 12 — a pre-existing key collision (the
    // XI/XII suffixes exist specifically to fix this). Catches it here in
    // case that first rename was never migrated.
    copyKeyToBoth("Maths|Relations & Functions", "Maths|Relations & Functions (XI)", "Maths|Relations & Functions (XII)");

    if (changed) saveSyllabusProgress(progress);
}

export function chapterProgressCount(progress, subject, chapter) {
    let entry = progress[subject + "|" + chapter] || {};
    return SYLLABUS_TAGS.filter(t => entry[t]).length;
}

export function toggleSyllabusChapterExpand(subject, chapter) {
    let key = subject + "|" + chapter;
    expandedSyllabusChapters[key] = !expandedSyllabusChapters[key];
    renderSyllabusTracker();
}

export function toggleSyllabusTag(subject, chapter, tag) {
    let progress = getSyllabusProgress();
    let key = subject + "|" + chapter;
    if (!progress[key]) progress[key] = {};
    progress[key][tag] = !progress[key][tag];
    saveSyllabusProgress(progress);
    renderSyllabusTracker();
}

export function setSyllabusSubject(subject) {
    activeSyllabusSubject = subject;
    renderSyllabusTracker();
}

export function renderSyllabusTracker() {
    let progress = getSyllabusProgress();
    let subjects = Object.keys(SYLLABUS_SUBJECTS);

    document.getElementById("syllabus-subject-tabs").innerHTML = subjects.map(s =>
        `<button class="${s === activeSyllabusSubject ? 'active' : ''}" onclick="setSyllabusSubject('${s.replace(/'/g,"\\'")}')">${escapeHtml(s)}</button>`
    ).join('');

    let totalTasks = 0, doneTasks = 0;
    subjects.forEach(s => {
        [11, 12].forEach(cls => {
            (SYLLABUS_SUBJECTS[s][cls] || []).forEach(ch => {
                totalTasks += SYLLABUS_TAGS.length;
                doneTasks += chapterProgressCount(progress, s, ch);
            });
        });
    });
    let overallPct = totalTasks ? Math.round((doneTasks / totalTasks) * 100) : 0;
    document.getElementById("syllabus-overall").innerHTML = `<div>Overall: <span class="highlight-text">${doneTasks}</span>/${totalTasks} tasks (<span class="highlight-text">${overallPct}%</span>)</div><div class="so-bar-track"><div class="so-bar-fill" style="width:${overallPct}%;"></div></div>`;

    let html = "";
    [11, 12].forEach(cls => {
        let chapters = SYLLABUS_SUBJECTS[activeSyllabusSubject][cls] || [];
        if (chapters.length === 0) return;
        html += `<div class="syllabus-class-header">Class ${cls}</div>`;
        chapters.forEach(ch => {
            let key = activeSyllabusSubject + "|" + ch;
            let done = chapterProgressCount(progress, activeSyllabusSubject, ch);
            let pct = Math.round((done / SYLLABUS_TAGS.length) * 100);
            let isExpanded = !!expandedSyllabusChapters[key];
            let entry = progress[key] || {};
            html += `<div class="syllabus-chapter-card ${isExpanded ? 'expanded' : ''}"><div class="sc-top" onclick="toggleSyllabusChapterExpand('${activeSyllabusSubject.replace(/'/g,"\\'")}','${ch.replace(/'/g,"\\'")}')"><span class="sc-name">${escapeHtml(ch)}</span><span class="sc-badge">${done}/${SYLLABUS_TAGS.length} · ${pct}%</span></div><div class="sc-bar-track"><div class="sc-bar-fill" style="width:${pct}%;"></div></div><div class="syllabus-tag-grid">${SYLLABUS_TAGS.map(t => `<span class="syllabus-tag-chip ${entry[t] ? 'done' : ''}" onclick="event.stopPropagation(); toggleSyllabusTag('${activeSyllabusSubject.replace(/'/g,"\\'")}','${ch.replace(/'/g,"\\'")}','${t}')">${t}</span>`).join('')}</div></div>`;
        });
    });
    document.getElementById("syllabus-chapter-list").innerHTML = html;
}
