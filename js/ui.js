import { shiftDateByYears, getTodayKey } from './utils.js';
import { getExamYear, setStoredExamYear, BASE_EXAM_YEAR, BASE_EXAM_DATES } from './storage.js';
import { getCurrentDayKey, setCurrentDayKey, flushAndRestartSegment, updateLiveSummary } from './timer.js';
import { initToday } from './storage.js';
import { renderSidebarTools, renderPlannerCalendar } from './planner.js';
// Forward reference — history.js/charts.js were built in earlier steps and
// have no dependency back on ui.js, so this is a normal (non-circular) import.
import { loadHistoryData } from './history.js';
import { renderGarden } from './charts.js';
import { runNotificationChecks } from './notifications.js';
import { renderMockTestList } from './mocktest.js';
import { renderSyllabusTracker } from './syllabus.js';
import { renderMistakesTracker } from './mistakes.js';

// ----------------- CACHE -----------------
// Some browsers (Edge in particular) make clearing site data + hard-reload
// a multi-step chore just to pick up a new deployed version, since sw.js
// serves cache-first. This does both in one click: drops every Cache
// Storage bucket this origin owns (the service worker's onactivate handler
// already deletes stale-named caches on its own, but this also covers the
// case where the SW itself hasn't updated yet) and unregisters the current
// service worker so the next load re-registers sw.js fresh, then reloads.
// Available both signed-out and signed-in — it never touches
// localStorage/IndexedDB study data, only the PWA cache layer.
export async function clearCacheAndReload() {
    if (!confirm("This clears the app's cached files and does a full reload to fetch the latest version. It doesn't touch your study data, but as a precaution — especially if you haven't synced in a while — consider exporting a backup or saving to cloud first. Continue?")) return;
    try {
        if ("caches" in window) {
            let keys = await caches.keys();
            await Promise.all(keys.map(k => caches.delete(k)));
        }
        if ("serviceWorker" in navigator) {
            let regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map(r => r.unregister()));
        }
    } catch (e) {
        // Even if clearing fails partway, still force the reload below —
        // a plain reload is strictly better than doing nothing.
    }
    // A plain location.reload() clears the SW/Cache-Storage layer above, but
    // the *browser's own HTTP disk cache* is a separate thing it does not
    // touch — GitHub Pages serves static files with a Cache-Control max-age,
    // so a normal reload can still silently reuse a stale cached index.html
    // or JS file without even asking the network. Navigating to a
    // cache-busted URL forces this to be treated as a brand-new resource,
    // guaranteeing a real network fetch instead of a disk-cache hit.
    let url = new URL(location.href);
    url.searchParams.set("_cb", Date.now().toString());
    location.replace(url.toString());
}

// ----------------- TOASTS -----------------
export function showToast(msg) {
    let stack = document.getElementById("toast-stack");
    let el = document.createElement("div");
    el.className = "toast";
    el.innerText = msg;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 8000);
}

// ----------------- SIDEBAR -----------------
let activeSidebarPanel = null;

export function closeSidebar() {
    let sidebar = document.getElementById("sidebar");
    sidebar.classList.remove("expanded");
    document.body.classList.remove("panel-open");
    document.getElementById("panel-planner").style.display = "none";
    document.getElementById("panel-mocktest").style.display = "none";
    document.getElementById("panel-syllabus").style.display = "none";
    document.getElementById("panel-mistakes").style.display = "none";
    document.getElementById("rail-planner-btn").classList.remove("active");
    document.getElementById("rail-mocktest-btn").classList.remove("active");
    document.getElementById("rail-syllabus-btn").classList.remove("active");
    document.getElementById("rail-mistakes-btn").classList.remove("active");
    activeSidebarPanel = null;
}

// Forward references to mocktest.js/syllabus.js render functions — called
// lazily inside this function body only, safe against the circular-ish
// module graph.

export function openSidebarPanel(name) {
    let sidebar = document.getElementById("sidebar");
    let planner = document.getElementById("panel-planner");
    let mocktest = document.getElementById("panel-mocktest");
    let syllabus = document.getElementById("panel-syllabus");
    let mistakes = document.getElementById("panel-mistakes");
    let plannerBtn = document.getElementById("rail-planner-btn");
    let mocktestBtn = document.getElementById("rail-mocktest-btn");
    let syllabusBtn = document.getElementById("rail-syllabus-btn");
    let mistakesBtn = document.getElementById("rail-mistakes-btn");
    if (activeSidebarPanel === name) { closeSidebar(); return; }
    sidebar.classList.add("expanded"); document.body.classList.add("panel-open"); activeSidebarPanel = name;
    planner.style.display = (name === "planner") ? "flex" : "none";
    mocktest.style.display = (name === "mocktest") ? "flex" : "none";
    syllabus.style.display = (name === "syllabus") ? "flex" : "none";
    mistakes.style.display = (name === "mistakes") ? "flex" : "none";
    plannerBtn.classList.toggle("active", name === "planner");
    mocktestBtn.classList.toggle("active", name === "mocktest");
    syllabusBtn.classList.toggle("active", name === "syllabus");
    mistakesBtn.classList.toggle("active", name === "mistakes");
    if (name === "mocktest") renderMockTestList();
    if (name === "syllabus") renderSyllabusTracker();
    if (name === "mistakes") renderMistakesTracker();
}

// ----------------- DAY ROLLOVER -----------------
export function checkDayRollover() {
    // BUG FIX: was `new Date().toISOString().split('T')[0]` (UTC date) —
    // see the comment on getTodayKey() in utils.js. That made day-rollover
    // fire at 5:30 AM local (IST) instead of local midnight, so anything
    // studied between 00:00–05:30 local got flushed/keyed to the wrong day.
    let nowKey = getTodayKey();
    if (nowKey === getCurrentDayKey()) return;
    flushAndRestartSegment();
    setCurrentDayKey(nowKey);
    renderQuoteOfDay(); initToday(); renderSidebarTools(); updateLiveSummary(); renderPlannerCalendar();
    let picker = document.getElementById("history-picker");
    let maxAttr = picker.getAttribute("max");
    if (picker.value === maxAttr) { picker.value = nowKey; loadHistoryData(); }
    picker.setAttribute("max", nowKey);
}

// ----------------- QUOTE OF THE DAY -----------------
const JEE_QUOTES = [
        { text: "I have not failed. I've just found 10,000 ways that won't work.", author: "Thomas Edison" },
        { text: "Success is not final, failure is not fatal: it is the courage to continue that counts.", author: "Winston Churchill" },
        { text: "Failure is simply the opportunity to begin again, this time more intelligently.", author: "Henry Ford" },
        { text: "A person who never made a mistake never tried anything new.", author: "Albert Einstein" },
        { text: "Do not judge me by my successes, judge me by how many times I fell down and got back up again.", author: "Nelson Mandela" },
        { text: "My great concern is not whether you have failed, but whether you are content with your failure.", author: "Abraham Lincoln" },
        { text: "Success consists of going from failure to failure without loss of enthusiasm.", author: "Winston Churchill" },
        { text: "You may encounter many defeats, but you must not be defeated.", author: "Maya Angelou" },
        { text: "The only real mistake is the one from which we learn nothing.", author: "Henry Ford" },
        { text: "Fail early, fail often, fail forward.", author: "John C. Maxwell" },
        { text: "Pain is inevitable. Suffering is optional.", author: "Haruki Murakami" },
        { text: "Our greatest glory is not in never falling, but in rising every time we fall.", author: "Confucius" },
        { text: "When you reach the end of your rope, tie a knot in it and hang on.", author: "Franklin D. Roosevelt" },
        { text: "Failure is another stepping stone to greatness.", author: "Oprah Winfrey" },
        { text: "End is not the end; in fact, E.N.D. means 'Effort Never Dies.'", author: "A.P.J. Abdul Kalam" },
        { text: "Don't carry your mistakes around with you. Instead, place them under your feet and use them as stepping stones.", author: "Alabaster Box" },
        { text: "It's not whether you get knocked down, it's whether you get up.", author: "Vince Lombardi" },
        { text: "Rock bottom became the solid foundation on which I rebuilt my life.", author: "J.K. Rowling" },
        { text: "I can accept failure, everyone fails at something. But I can't accept not trying.", author: "Michael Jordan" },
        { text: "There is no failure except in no longer trying.", author: "Elbert Hubbard" },
        { text: "Character cannot be developed in ease and quiet. Only through experience of trial and suffering can the soul be strengthened.", author: "Helen Keller" },
        { text: "Fall seven times, stand up eight.", author: "Japanese Proverb" },
        { text: "Never confuse a single defeat with a final defeat.", author: "F. Scott Fitzgerald" },
        { text: "If you're going through hell, keep going.", author: "Winston Churchill" },
        { text: "Doubt kills more dreams than failure ever will.", author: "Suzy Kassem" },
        { text: "Mistakes are proof that you are trying.", author: "Sam Levenson" },
        { text: "Show me a person who has never made a mistake and I'll show you someone who has never achieved much.", author: "Joan Collins" },
        { text: "You learn more from failure than from success. Don't let it stop you. Failure builds character.", author: "Unknown" },
        { text: "Turn your wounds into wisdom.", author: "Oprah Winfrey" },
        { text: "Giving up is the only sure way to fail.", author: "Gena Showalter" },
        { text: "The comeback is always stronger than the setback.", author: "Anonymous" },
        { text: "Defeat is not the worst of failures. Not to have tried is the true failure.", author: "George Edward Woodberry" },
        { text: "No test can define your intelligence; it only measures your preparation on that day.", author: "Anonymous" },
        { text: "Every master was once a disaster.", author: "T. Harv Eker" },
        { text: "The struggle you're in today is developing the strength you need for tomorrow.", author: "Robert Tew" },
        { text: "Difficulties strengthen the mind, as labor does the body.", author: "Seneca" },
        { text: "Persistence guarantees that results are inevitable.", author: "Paramahansa Yogananda" },
        { text: "It does not matter how many times you fail. You only have to be right once.", author: "Mark Cuban" },
        { text: "Smooth seas do not make skillful sailors.", author: "African Proverb" },
        { text: "Every adversity, every failure, every heartache carries with it the seed of an equal or greater benefit.", author: "Napoleon Hill" },
        { text: "The oak fought the wind and was broken, the willow bent when it must and survived.", author: "Robert Jordan" },
        { text: "You never lose. You either win or you learn.", author: "Nelson Mandela" },
        { text: "Prosperity is a great teacher; adversity is a greater.", author: "William Hazlitt" },
        { text: "Mock tests exist to expose your weaknesses before the real test exposes them.", author: "Anonymous" },
        { text: "A setback is a setup for a comeback.", author: "Willie Jolley" },
        { text: "We are what we repeatedly do. Excellence, then, is not an act, but a habit.", author: "Will Durant (summarizing Aristotle)" },
        { text: "Success is the sum of small efforts, repeated day-in and day-out.", author: "Robert Collier" },
        { text: "Discipline is the bridge between goals and accomplishment.", author: "Jim Rohn" },
        { text: "Motivation gets you going, but discipline keeps you growing.", author: "John C. Maxwell" },
        { text: "Success isn't always about greatness. It's about consistency. Consistent hard work leads to success.", author: "Dwayne Johnson" },
        { text: "Small disciplines repeated with consistency every day lead to great achievements gained slowly over time.", author: "John C. Maxwell" },
        { text: "Don't count the days, make the days count.", author: "Muhammad Ali" },
        { text: "Amateurs sit and wait for inspiration, the rest of us just get up and go to work.", author: "Stephen King" },
        { text: "Perseverance is the hard work you do after you get tired of doing the hard work you already did.", author: "Newt Gingrich" },
        { text: "Energy and persistence conquer all things.", author: "Benjamin Franklin" },
        { text: "It does not matter how slowly you go as long as you do not stop.", author: "Confucius" },
        { text: "The secret of your future is hidden in your daily routine.", author: "Mike Murdock" },
        { text: "Today I will do what others won't, so tomorrow I can accomplish what others can't.", author: "Jerry Rice" },
        { text: "Discipline is choosing between what you want now and what you want most.", author: "Abraham Lincoln" },
        { text: "The only place where success comes before work is in the dictionary.", author: "Vidal Sassoon" },
        { text: "Continuous effort—not strength or intelligence—is the key to unlocking our potential.", author: "Winston Churchill" },
        { text: "Action is the foundational key to all success.", author: "Pablo Picasso" },
        { text: "The difference between ordinary and extraordinary is that little extra.", author: "Jimmy Johnson" },
        { text: "You cannot change your future, but you can change your habits, and surely your habits will change your future.", author: "A.P.J. Abdul Kalam" },
        { text: "Chop your own wood and it will warm you twice.", author: "Henry Ford" },
        { text: "Patience, persistence, and perspiration make an unbeatable combination for success.", author: "Napoleon Hill" },
        { text: "Step by step and the thing is done.", author: "Charles Atlas" },
        { text: "Long-term consistency trumps short-term intensity.", author: "Bruce Lee" },
        { text: "Do something today that your future self will thank you for.", author: "Sean Patrick Flanery" },
        { text: "Work hard in silence, let your success be your noise.", author: "Frank Ocean" },
        { text: "The obsession with running every day is not about running, it's about life.", author: "Kilian Jornet" },
        { text: "Self-discipline is the magic power that makes you virtually unstoppable.", author: "Dan Kennedy" },
        { text: "Daily practice is the price of mastery.", author: "Robin Sharma" },
        { text: "The hard work you put in when no one is watching will matter far more.", author: "Leslie Odom Jr." },
        { text: "Grit is living life like it's a marathon, not a sprint.", author: "Angela Duckworth" },
        { text: "A year from now you may wish you had started today.", author: "Karen Lamb" },
        { text: "Don't stop when you're tired. Stop when you're done.", author: "David Goggins" },
        { text: "Consistency is what transforms average into excellence.", author: "Anonymous" },
        { text: "Hard work beats talent when talent doesn't work hard.", author: "Tim Notke" },
        { text: "Make each day your masterpiece.", author: "John Wooden" },
        { text: "Discipline equals freedom.", author: "Jocko Willink" },
        { text: "Patience is not passive; on the contrary, it is concentrated strength.", author: "Bruce Lee" },
        { text: "Great works are performed not by strength but by perseverance.", author: "Samuel Johnson" },
        { text: "Champions don't do extraordinary things. They do ordinary things, but they do them without thinking, extraordinary fast.", author: "Charles Duhigg" },
        { text: "The successful warrior is the average person, with laser-like focus.", author: "Bruce Lee" },
        { text: "I have no special talent. I am only passionately curious.", author: "Albert Einstein" },
        { text: "Science is a way of thinking much more than it is a body of knowledge.", author: "Carl Sagan" },
        { text: "Somewhere, something incredible is waiting to be known.", author: "Carl Sagan" },
        { text: "Nothing in life is to be feared, it is only to be understood. Now is the time to understand more, so that we may fear less.", author: "Marie Curie" },
        { text: "The important thing is to not stop questioning.", author: "Albert Einstein" },
        { text: "Research is what I'm doing when I don't know what I'm doing.", author: "Wernher von Braun" },
        { text: "Look up at the stars and not down at your feet. Try to make sense of what you see.", author: "Stephen Hawking" },
        { text: "The reward of the young scientist is the emotional thrill of being the first person in the history of the world to see something or to understand something.", author: "Cecilia Payne-Gaposchkin" },
        { text: "Equipped with his five senses, man explores the universe around him and calls the adventure Science.", author: "Edwin Hubble" },
        { text: "Scientists have become the bearers of the torch of discovery in our quest for knowledge.", author: "Stephen Hawking" },
        { text: "Science knows no country, because knowledge belongs to humanity.", author: "Louis Pasteur" },
        { text: "If you want to understand the universe, think in terms of energy, frequency and vibration.", author: "Nikola Tesla" },
        { text: "To know that we know what we know, and that we do not know what we do not know, that is true knowledge.", author: "Nicolaus Copernicus" },
        { text: "What I cannot create, I do not understand.", author: "Richard Feynman" },
        { text: "Everything is theoretically impossible, until it is done.", author: "Robert A. Heinlein" },
        { text: "The science of today is the technology of tomorrow.", author: "Edward Teller" },
        { text: "One never notices what has been done; one can only see what remains to be done.", author: "Marie Curie" },
        { text: "Study hard what interests you most in the most undisciplined, irreverent and original manner possible.", author: "Richard Feynman" },
        { text: "Knowledge is power, but curiosity is the spark.", author: "Anonymous" },
        { text: "An investment in knowledge pays the best interest.", author: "Benjamin Franklin" },
        { text: "In physics, you don't have to memorize; you have to visualize.", author: "Anonymous" },
        { text: "To be a scientist is to be an eternal student.", author: "Anonymous" },
        { text: "Clarity of concepts is the shield against tricky questions.", author: "Anonymous" },
        { text: "Mathematics reveals its secrets only to those who approach it with pure love, for its own beauty.", author: "Archimedes" },
        { text: "The art of discovery is the art of asking the right questions.", author: "Albert Szent-Györgyi" },
        { text: "Understanding a concept once is better than memorizing it a hundred times.", author: "Anonymous" },
        { text: "Science is organized knowledge. Wisdom is organized life.", author: "Immanuel Kant" },
        { text: "Physics is the poetry of nature written in the language of mathematics.", author: "Anonymous" },
        { text: "Deep practice turns difficult problems into clear solutions.", author: "Anonymous" },
        { text: "When you understand the why, the how becomes effortless.", author: "Anonymous" },
        { text: "The Good Thing about science is that it's true whether or not you believe in it.", author: "Neil deGrasse Tyson" },
        { text: "All bounds are limits of our own understanding.", author: "Michael Faraday" },
        { text: "Fascinating insights lie just beneath the surface of basic formulas.", author: "Anonymous" },
        { text: "Concept over memory, always.", author: "Anonymous" },
        { text: "True learning is learning how to think, not what to memorize.", author: "Anonymous" },
        { text: "Concentrate all your thoughts upon the work at hand. The sun's rays do not burn until brought to a focus.", author: "Alexander Graham Bell" },
        { text: "Starve your distractions, feed your focus.", author: "Unknown" },
        { text: "It is not that we have a short time to live, but that we waste a lot of it.", author: "Seneca" },
        { text: "Lack of direction, not lack of time, is the problem. We all have twenty-four hour days.", author: "Zig Ziglar" },
        { text: "You will never reach your destination if you stop and throw stones at every dog that barks.", author: "Winston Churchill" },
        { text: "Focus is a matter of deciding what things you're not going to do.", author: "John Carmack" },
        { text: "The successful warrior is the average man, with laser-like focus.", author: "Bruce Lee" },
        { text: "Time management is life management.", author: "Robin Sharma" },
        { text: "Saying no to distractions allows you to say yes to your destination.", author: "Anonymous" },
        { text: "Your future is created by what you do today, not tomorrow.", author: "Robert Kiyosaki" },
        { text: "Multitasking is a lie. Do one thing with 100% focus.", author: "Gary Keller" },
        { text: "Time is what we want most, but what we use worst.", author: "William Penn" },
        { text: "You have power over your mind — not outside events. Realize this, and you will find strength.", author: "Marcus Aurelius" },
        { text: "Deep work is the ability to focus without distraction on a cognitively demanding task.", author: "Cal Newport" },
        { text: "Where focus goes, energy flows.", author: "Tony Robbins" },
        { text: "Protect your peace and protect your study hours.", author: "Anonymous" },
        { text: "The main thing is to keep the main thing the main thing.", author: "Stephen Covey" },
        { text: "Either you run the day or the day runs you.", author: "Jim Rohn" },
        { text: "A goal without a plan is just a wish.", author: "Antoine de Saint-Exupéry" },
        { text: "Procrastination is the thief of time.", author: "Edward Young" },
        { text: "The key is not to prioritize what's on your schedule, but to schedule your priorities.", author: "Stephen Covey" },
        { text: "Focus on being productive instead of busy.", author: "Tim Ferriss" },
        { text: "Cut out the noise. The exam room only tests your mind, not social media.", author: "Anonymous" },
        { text: "Simplicity is the ultimate sophistication.", author: "Leonardo da Vinci" },
        { text: "Silence the world, turn on the desk lamp.", author: "Anonymous" },
        { text: "Your focus determines your reality.", author: "George Lucas" },
        { text: "Delay gratification today for a rank you will cherish tomorrow.", author: "Anonymous" },
        { text: "Don't manage time, manage your attention.", author: "Adam Grant" },
        { text: "One task, one goal, zero distractions.", author: "Anonymous" },
        { text: "To achieve great things, two things are needed; a plan, and not quite enough time.", author: "Leonard Bernstein" },
        { text: "Do the hard job first. The easy jobs will take care of themselves.", author: "Dale Carnegie" },
        { text: "You don't need more time, you need more intensity.", author: "Anonymous" },
        { text: "Master your focus and you master your rank.", author: "Anonymous" },
        { text: "Sacrifice short-term comfort for long-term pride.", author: "Anonymous" },
        { text: "When you focus on the process, results follow automatically.", author: "Anonymous" },
        { text: "Until you value yourself, you won't value your time.", author: "M. Scott Peck" },
        { text: "Efficiency is doing things right; effectiveness is doing the right things.", author: "Peter Drucker" },
        { text: "Distractions are the enemies of high performance.", author: "Anonymous" },
        { text: "Mastering your morning schedule secures the rest of your day.", author: "Anonymous" },
        { text: "Give me six hours to chop down a tree and I will spend the first four sharpening the axe.", author: "Abraham Lincoln" },
        { text: "Dream, dream, dream. Dreams transform into thoughts and thoughts result in action.", author: "A.P.J. Abdul Kalam" },
        { text: "Believe you can and you're halfway there.", author: "Theodore Roosevelt" },
        { text: "Shoot for the moon. Even if you miss, you'll land among the stars.", author: "Les Brown" },
        { text: "The future belongs to those who believe in the beauty of their dreams.", author: "Eleanor Roosevelt" },
        { text: "If you think you can do a thing or think you can't do a thing, you're right.", author: "Henry Ford" },
        { text: "Self-belief and hard work will always earn you success.", author: "Virat Kohli" },
        { text: "Look at the sky. We are not alone. The whole universe is friendly to us and conspires only to those who dream and work.", author: "A.P.J. Abdul Kalam" },
        { text: "High aims form the high character.", author: "A.P.J. Abdul Kalam" },
        { text: "There are no limits to what you can accomplish, except the limits you place on your own thinking.", author: "Brian Tracy" },
        { text: "The only limit to our realization of tomorrow will be our doubts of today.", author: "Franklin D. Roosevelt" },
        { text: "Set your goals high, and don't stop till you get there.", author: "Bo Jackson" },
        { text: "No one can make you feel inferior without your consent.", author: "Eleanor Roosevelt" },
        { text: "Intelligence without ambition is a bird without wings.", author: "Salvador Dalí" },
        { text: "It always seems impossible until it's done.", author: "Nelson Mandela" },
        { text: "Don't be pushed around by the fears in your mind. Be led by the dreams in your heart.", author: "Roy T. Bennett" },
        { text: "The size of your success is measured by the strength of your desire.", author: "Robert Kiyosaki" },
        { text: "Aim for the Top 100, not just a pass mark.", author: "Anonymous" },
        { text: "Never downgrade your dream just to fit your reality. Upgrade your conviction to match your destiny.", author: "Anonymous" },
        { text: "What you get by achieving your goals is not as important as what you become by achieving your goals.", author: "Zig Ziglar" },
        { text: "Make your ambition bigger than your fears.", author: "Anonymous" },
        { text: "The mind is everything. What you think you become.", author: "Buddha" },
        { text: "Limits exist only in the mind.", author: "Anonymous" },
        { text: "Go as far as you can see; when you get there, you'll be able to see further.", author: "Thomas Carlyle" },
        { text: "Don't limit your challenges. Challenge your limits.", author: "Jerry Dunn" },
        { text: "Pressure is a privilege — it means you're in a position to achieve great things.", author: "Billie Jean King" },
        { text: "You were born with wings, don't crawl through life.", author: "Rumi" },
        { text: "To be a champion, you have to believe in yourself when nobody else will.", author: "Sugar Ray Robinson" },
        { text: "Believe in your infinite potential. Your only limitations are those you set upon yourself.", author: "Roy T. Bennett" },
        { text: "Great minds discuss ideas; average minds discuss events; small minds discuss people.", author: "Eleanor Roosevelt" },
        { text: "If your dreams don't scare you, they are too small.", author: "Richard Branson" },
        { text: "The only person you are destined to become is the person you decide to be.", author: "Ralph Waldo Emerson" },
        { text: "Rise above the average, push beyond your limits, and conquer the paper.", author: "Anonymous" },
        { text: "Confidence comes from discipline and training.", author: "Robert Holtz" },
        { text: "Small minds aim for comfort; great minds aim for mastery.", author: "Anonymous" },
        { text: "You have the power to write your own rank. Now go build it.", author: "Anonymous" },
        { text: "Think big, start small, act now.", author: "Robin Sharma" },
        { text: "A mental attitude that is centered on success will attract success.", author: "Anonymous" },
        { text: "Your capacity is infinitely greater than your current effort suggests.", author: "Anonymous" },
        { text: "Refuse to settle for anything less than your absolute best.", author: "Anonymous" },
        { text: "The rank you want is waiting for the effort you haven't given yet.", author: "Anonymous" }
];

let lastQuoteBucket = null;
export function renderQuoteOfDay() {
    let bucket = Math.floor((Date.now() + 5.5 * 3600000) / (6 * 60 * 60 * 1000));
    lastQuoteBucket = bucket;
    let q = JEE_QUOTES[bucket % JEE_QUOTES.length];
    document.getElementById("quote-of-day").innerHTML = `<span class="quote-text">"${q.text}"</span><span class="quote-author">— ${q.author}</span>`;
}

// ----------------- EXAM YEAR / COUNTDOWNS -----------------
function fmtExamDate(d) { return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }

let JEE_MAINS_DATE, JEE_MAINS2_DATE, JEE_ADV_DATE;

export function rebuildExamDates() {
    let offset = getExamYear() - BASE_EXAM_YEAR;
    JEE_MAINS_DATE = shiftDateByYears(BASE_EXAM_DATES.mains1, offset);
    JEE_MAINS2_DATE = shiftDateByYears(BASE_EXAM_DATES.mains2, offset);
    JEE_ADV_DATE = shiftDateByYears(BASE_EXAM_DATES.adv, offset);
}
rebuildExamDates();

export function renderExamYearUI() {
    let year = getExamYear();
    document.title = `JEE ${year} Study Tracker & Planner`;
    document.getElementById("app-title-main").innerHTML = `JEE ${year} <span class="app-title-emoji">🎯</span>`;
    document.getElementById("chip-mains1").title = `JEE Main ${year} (Session 1) — ${fmtExamDate(JEE_MAINS_DATE)}`;
    document.getElementById("chip-mains2").title = `JEE Main ${year} (Session 2) — ${fmtExamDate(JEE_MAINS2_DATE)}`;
    document.getElementById("chip-adv").title = `JEE Advanced ${year} — ${fmtExamDate(JEE_ADV_DATE)}`;
    let sel = document.getElementById("exam-year-select");
    if (sel) {
        if (!sel.options.length) {
            for (let y = 2027; y <= 2031; y++) {
                let opt = document.createElement("option");
                opt.value = y; opt.innerText = `JEE ${y}`;
                sel.appendChild(opt);
            }
        }
        sel.value = String(year);
    }
}

export function setExamYear(year) {
    setStoredExamYear(year);
    rebuildExamDates();
    renderExamYearUI();
    tickCountdowns();
}

export function updateCountdown(targetDate, daysElId, subElId) {
    let now = new Date();
    let diffMs = targetDate - now;
    let daysEl = document.getElementById(daysElId);
    if (diffMs <= 0) {
        daysEl.classList.add("exam-today");
        daysEl.innerHTML = "Exam Day! 🎯";
        document.getElementById(subElId).innerText = "All the best!";
        return;
    }
    let totalSec = Math.floor(diffMs / 1000);
    let days = Math.floor(totalSec / 86400) + 1;
    let hrs = Math.floor((totalSec % 86400) / 3600);
    let mins = Math.floor((totalSec % 3600) / 60);
    let secs = totalSec % 60;
    daysEl.classList.remove("exam-today");
    daysEl.innerHTML = `${days}<span class="chip-days-unit">days</span>`;
    document.getElementById(subElId).innerText = `${hrs}h ${mins}m ${secs}s`;
}

export function tickCountdowns() {
    updateCountdown(JEE_MAINS_DATE, "cd-mains-days", "cd-mains-sub");
    updateCountdown(JEE_MAINS2_DATE, "cd-mains2-days", "cd-mains2-sub");
    updateCountdown(JEE_ADV_DATE, "cd-adv-days", "cd-adv-sub");
    checkDayRollover();
    let bucket = Math.floor((Date.now() + 5.5 * 3600000) / (6 * 60 * 60 * 1000));
    if (bucket !== lastQuoteBucket) { renderQuoteOfDay(); lastQuoteBucket = bucket; }
    runNotificationChecks();
    renderGarden();
}
