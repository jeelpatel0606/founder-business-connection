/**
 * Founder Business Connection - Universal Multi-Industry Platform
 * Interactive Image Adjuster & Cropper (Reposition, Pan, Zoom, Rotate)
 * Security: SHA-256 hashing, rate limiting, session expiry, XSS sanitization
 */

/* ==========================================================================
   SECURITY UTILITIES
   ========================================================================== */

/**
 * SHA-256 hash using Web Crypto API (async, returns hex string)
 */
async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Sanitize a string to prevent XSS — escapes HTML special characters.
 */
function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Validate password strength.
 * Rules: 8+ chars, 1 uppercase, 1 number, 1 special character.
 * Returns { valid: bool, message: string }
 */
function validatePasswordStrength(password) {
  if (password.length < 8)
    return { valid: false, message: 'Password must be at least 8 characters.' };
  if (!/[A-Z]/.test(password))
    return { valid: false, message: 'Password must include at least one uppercase letter (A-Z).' };
  if (!/[0-9]/.test(password))
    return { valid: false, message: 'Password must include at least one number (0-9).' };
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password))
    return { valid: false, message: 'Password must include at least one special character (!@#$%^&*).' };
  return { valid: true, message: 'Strong password ✓' };
}

/**
 * Get password strength score (0–4) for UI meter.
 */
function getPasswordStrengthScore(password) {
  let score = 0;
  if (password.length >= 8) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) score++;
  return score;
}

/* ── Login Rate-Limiting ── */
const RATE_LIMIT_MAX   = 5;          // max failed attempts
const RATE_LIMIT_MS    = 5 * 60 * 1000; // 5-minute lockout window
const SESSION_TTL_MS   = 24 * 60 * 60 * 1000; // 24-hour session

function getRateLimitState(email) {
  const raw = localStorage.getItem(`fbc_rl_${email}`);
  return raw ? JSON.parse(raw) : { attempts: 0, lockedUntil: 0 };
}

function setRateLimitState(email, state) {
  localStorage.setItem(`fbc_rl_${email}`, JSON.stringify(state));
}

function recordFailedAttempt(email) {
  const rl = getRateLimitState(email);
  rl.attempts = (rl.attempts || 0) + 1;
  if (rl.attempts >= RATE_LIMIT_MAX) {
    rl.lockedUntil = Date.now() + RATE_LIMIT_MS;
    rl.attempts = 0; // reset counter after lock
  }
  setRateLimitState(email, rl);
}

function clearFailedAttempts(email) {
  localStorage.removeItem(`fbc_rl_${email}`);
}

function isAccountLocked(email) {
  const rl = getRateLimitState(email);
  if (rl.lockedUntil && Date.now() < rl.lockedUntil) {
    const remaining = Math.ceil((rl.lockedUntil - Date.now()) / 1000);
    return { locked: true, remaining };
  }
  return { locked: false };
}

/**
 * Check and enforce session expiry (24h). Called on page load.
 */
function checkSessionExpiry() {
  const sessionMeta = localStorage.getItem('fbc_session_meta');
  if (!sessionMeta) return;
  const { loginTime } = JSON.parse(sessionMeta);
  if (Date.now() - loginTime > SESSION_TTL_MS) {
    // Session expired — force logout
    localStorage.removeItem('fbc_current_user');
    localStorage.removeItem('fbc_session_meta');
    showToast('🔒 Your session expired. Please log in again.');
  }
}

/**
 * Hash admin password once and migrate all plain-text passwords to hashed on first load.
 * This is a one-time migration that runs transparently.
 */
async function migratePasswordsToHashed() {
  const users = getRegisteredUsers();
  let changed = false;
  for (const u of users) {
    // If password is NOT already a 64-char hex (SHA-256), hash it
    if (u.password && !/^[a-f0-9]{64}$/.test(u.password)) {
      u.password = await sha256(u.password);
      changed = true;
    }
  }
  if (changed) {
    saveRegisteredUsers(users);
    // Also update currentUser session if active
    const cur = JSON.parse(localStorage.getItem('fbc_current_user') || 'null');
    if (cur) {
      const updated = users.find(u => u.id === cur.id);
      if (updated) localStorage.setItem('fbc_current_user', JSON.stringify(updated));
    }
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  checkSessionExpiry();
  initTheme();
  initUsersDatabase();
  await migratePasswordsToHashed();
  initAuth();
  loadBusinesses();
  renderCategories();
  renderCurrentView();
  setupEventListeners();
  initCropDragListeners();
});

/* ==========================================================================
   State Management
   ========================================================================== */
const state = {
  activeCategory: 'all',
  searchQuery: '',
  businesses: [],
  currentUser: JSON.parse(localStorage.getItem('fbc_current_user') || 'null'),
  bookmarkedIds: JSON.parse(localStorage.getItem('fbc_bookmarks') || '[]'),
  deletedBizIds: JSON.parse(localStorage.getItem('fbc_deleted_biz_ids') || '[]'),
  authTab: 'login',
  bookmarkFilter: false,   // show only saved businesses
  sortBy: 'default'        // 'default' | 'rating' | 'newest'
};

// Interactive Crop State
const cropState = {
  active: false,
  mode: 'avatar', // 'avatar' | 'cover'
  imageSrc: '',
  scale: 1.0,
  rotation: 0,
  posX: 0,
  posY: 0,
  isDragging: false,
  startX: 0,
  startY: 0,
  naturalWidth: 0,
  naturalHeight: 0
};

// Clean Neutral Placeholder SVGs
const DEFAULT_AVATAR_PLACEHOLDER = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 24 24' fill='%236b7280' style='background:%23e5e7eb;'><path d='M12 12c2.65 0 4.8-2.15 4.8-4.8S14.65 2.4 12 2.4 7.2 4.55 7.2 7.2 9.35 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z'/></svg>";
const DEFAULT_COVER_PLACEHOLDER = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='800' height='300' viewBox='0 0 800 300'><rect width='800' height='300' fill='%231e293b'/><text x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%2394a3b8' font-family='sans-serif' font-size='18' font-weight='bold'>Upload Your Factory / Industry Image</text></svg>";

/* ==========================================================================
   Seed & Initialize User Database with Admin & Client Accounts
   ========================================================================== */
function initUsersDatabase() {
  const existingUsers = localStorage.getItem('fbc_registered_users');
  let users = existingUsers ? JSON.parse(existingUsers) : [];

  const masterAdminEmail = "admin@businessconnection.com";
  let adminUser = users.find(u => u.email === masterAdminEmail);
  
  if (!adminUser) {
    // Admin password is stored as SHA-256 hash — plain text never stored
    // Hash of "Jeel@Admin2026" — do NOT store plain text passwords
    sha256("Jeel@Admin2026").then(hashedPwd => {
      adminUser = {
        id: "admin-master-001",
        name: "Jeel Patel",
        email: masterAdminEmail,
        password: hashedPwd,
        role: "super_admin",
        businessName: "Platform Owner / Management",
        ownerAvatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=300&q=80",
        businessImage: "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=800&q=80",
        category: "services",
        categoryLabel: "Professional Services",
        city: "Ahmedabad, Gujarat",
        phone: "+91 98250 12345",
        tagline: "Founder & Master Platform Administrator",
        lookingFor: "Business Inquiries & Platform Moderation",
        offers: "B2B Founder Network & Company Verification",
        profileCompleted: true
      };
      users.unshift(adminUser);
      localStorage.setItem('fbc_registered_users', JSON.stringify(users));
    });
  }
}

function getRegisteredUsers() {
  return JSON.parse(localStorage.getItem('fbc_registered_users') || '[]');
}

function saveRegisteredUsers(users) {
  localStorage.setItem('fbc_registered_users', JSON.stringify(users));
}

function loadBusinesses() {
  const localSaved = JSON.parse(localStorage.getItem('fbc_custom_businesses') || '[]');
  const allRaw = [...localSaved, ...initialBusinesses];
  state.businesses = allRaw.filter(b => !state.deletedBizIds.includes(b.id));
}

/* ==========================================================================
   View Switcher: Public Landing (Intro) vs Member Directory
   ========================================================================== */
function renderCurrentView() {
  const publicView = document.getElementById('public-landing-view');
  const memberView = document.getElementById('member-directory-view');
  const navProfileBtn = document.getElementById('nav-profile-btn');

  if (state.currentUser) {
    if (publicView) publicView.classList.add('hidden');
    if (memberView) memberView.classList.remove('hidden');
    if (navProfileBtn) navProfileBtn.classList.remove('hidden');
    renderBusinesses();
  } else {
    if (publicView) publicView.classList.remove('hidden');
    if (memberView) memberView.classList.add('hidden');
    if (navProfileBtn) navProfileBtn.classList.add('hidden');
  }
}

/* ==========================================================================
   Theme Switcher (Pure Tailwind dark: class Toggle)
   ========================================================================== */
function initTheme() {
  const toggleBtn = document.getElementById('theme-toggle');
  const savedTheme = localStorage.getItem('fbc_theme') || 'dark';

  if (savedTheme === 'light') {
    document.documentElement.classList.remove('dark');
    updateThemeLabel(true);
  } else {
    document.documentElement.classList.add('dark');
    updateThemeLabel(false);
  }

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const isDark = document.documentElement.classList.toggle('dark');
      const theme = isDark ? 'dark' : 'light';
      localStorage.setItem('fbc_theme', theme);
      updateThemeLabel(!isDark);
      showToast(isDark ? '🌙 Switched to Dark Mode' : '☀️ Switched to Light Mode');
    });
  }
}

function updateThemeLabel(isLight) {
  const icon = document.getElementById('theme-icon');
  const text = document.getElementById('theme-text');
  if (icon) {
    icon.className = isLight ? 'fa-solid fa-moon text-xs' : 'fa-solid fa-sun text-xs';
  }
  if (text) {
    text.innerText = isLight ? 'Dark Mode' : 'Light Mode';
  }
}

/* ==========================================================================
   Authentication & Header State
   ========================================================================== */
function initAuth() {
  renderAuthHeader();
  renderAuthBanner();
}

function calculateProfileProgress(user) {
  if (!user) return 0;
  if (user.role === 'super_admin') return 100;
  let score = 35;
  if (user.businessName && user.businessName.trim() !== '') score += 20;
  if (user.city && user.city.trim() !== '') score += 15;
  if (user.phone && user.phone.trim() !== '') score += 15;
  if (user.lookingFor && user.lookingFor.trim() !== '') score += 15;
  return Math.min(100, score);
}

function renderAuthHeader() {
  const container = document.getElementById('auth-header-container');
  if (!container) return;

  if (state.currentUser) {
    const isSuperAdmin = state.currentUser.role === 'super_admin';
    const progress = calculateProfileProgress(state.currentUser);
    const isComplete = progress >= 85;
    const avatar = state.currentUser.ownerAvatar || DEFAULT_AVATAR_PLACEHOLDER;

    container.innerHTML = `
      <div class="flex items-center gap-2">
        <button onclick="openProfileModal()" class="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-neutral-300 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-900 hover:border-black dark:hover:border-white text-left transition">
          <img src="${avatar}" alt="${state.currentUser.name}" class="w-6 h-6 rounded-full object-cover border border-neutral-400 dark:border-neutral-600 bg-neutral-200">
          <div class="hidden sm:block leading-tight">
            <span class="text-xs font-bold text-neutral-900 dark:text-white block truncate max-w-[120px]">
              ${state.currentUser.name}
            </span>
            <span class="text-[10px] ${isSuperAdmin ? 'text-neutral-900 dark:text-white font-bold' : (isComplete ? 'text-neutral-500 dark:text-neutral-400' : 'text-amber-600 dark:text-amber-400 font-bold')} block">
              ${isSuperAdmin ? 'Master Access' : (isComplete ? (state.currentUser.businessName || 'Profile 100%') : `⚠️ Profile ${progress}%`)}
            </span>
          </div>
        </button>

        <button onclick="handleLogout()" class="px-3 py-1.5 rounded-xl border border-neutral-300 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-900 hover:border-black dark:hover:border-white text-neutral-700 dark:text-neutral-300 text-xs font-semibold transition" title="Log Out">
          <i class="fa-solid fa-arrow-right-from-bracket"></i>
        </button>
      </div>
    `;
  } else {
    container.innerHTML = `
      <div class="flex items-center gap-2">
        <button onclick="openAuthModal('login')" class="px-3 py-1.5 rounded-xl border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 hover:border-black dark:hover:border-white text-neutral-900 dark:text-white text-xs font-bold transition">
          <i class="fa-solid fa-lock text-xs"></i> Log In
        </button>
        <button onclick="openAuthModal('register')" class="px-3 py-1.5 rounded-xl bg-black text-white dark:bg-white dark:text-black hover:opacity-90 text-xs font-bold hidden sm:inline-flex shadow-sm transition">
          Sign Up (Free)
        </button>
      </div>
    `;
  }
}

function renderAuthBanner() {
  const banner = document.getElementById('auth-status-banner');
  if (!banner) return;

  if (state.currentUser) {
    const isSuperAdmin = state.currentUser.role === 'super_admin';

    if (isSuperAdmin) {
      banner.innerHTML = `
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs">
          <div class="flex items-center gap-2 text-neutral-800 dark:text-neutral-200 font-medium">
            <span class="w-2 h-2 rounded-full bg-black dark:bg-white animate-ping"></span>
            <span>Logged in with <strong>Management Access</strong> (${state.currentUser.name}). You can remove/delete any company listing.</span>
          </div>
          <div class="flex items-center gap-3">
            ${state.deletedBizIds.length > 0 ? `
              <button onclick="handleRestoreAllDeleted()" class="text-neutral-600 dark:text-neutral-400 hover:text-black dark:hover:text-white underline text-[11px]">
                Restore ${state.deletedBizIds.length} Deleted Companies
              </button>
            ` : ''}
            <button onclick="handleLogout()" class="text-neutral-600 dark:text-neutral-400 hover:text-black dark:hover:text-white underline text-[11px]">
              Logout
            </button>
          </div>
        </div>
      `;
      banner.className = "border-b border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900 block";
    } else {
      const progress = calculateProfileProgress(state.currentUser);
      const isComplete = progress >= 85;

      if (!isComplete) {
        banner.innerHTML = `
          <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs">
            <div class="flex items-center gap-2 text-neutral-800 dark:text-neutral-300">
              <span class="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span>
              <span>Welcome <strong>${state.currentUser.name}</strong>! Your Business Profile is <strong>${progress}% complete</strong>. Complete your profile to get verified.</span>
            </div>
            <button onclick="openProfileModal()" class="px-3 py-1 rounded-lg bg-black text-white dark:bg-white dark:text-black font-bold text-xs hover:opacity-90 shrink-0">
              Complete Profile &rarr;
            </button>
          </div>
        `;
        banner.className = "border-b border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900 block";
      } else {
        banner.innerHTML = `
          <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2 flex items-center justify-between text-xs">
            <div class="flex items-center gap-2 text-neutral-800 dark:text-neutral-300">
              <i class="fa-solid fa-circle-check text-neutral-900 dark:text-white"></i>
              <span>Logged in as <strong class="text-neutral-900 dark:text-white">${state.currentUser.name}</strong> (${state.currentUser.businessName}). Direct WhatsApp & contacts <strong>Unlocked</strong>.</span>
            </div>
            <div class="flex items-center gap-3">
              <button onclick="openProfileModal()" class="text-neutral-600 dark:text-neutral-400 hover:text-black dark:hover:text-white underline text-[11px]">
                Upload Photos & Edit Profile
              </button>
              <button onclick="handleLogout()" class="text-neutral-500 dark:text-neutral-400 hover:text-black dark:hover:text-white text-[11px]">
                Logout
              </button>
            </div>
          </div>
        `;
        banner.className = "border-b border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-950 block";
      }
    }
  } else {
    banner.innerHTML = `
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs">
        <div class="flex items-center gap-2 text-neutral-700 dark:text-neutral-300">
          <i class="fa-solid fa-shield-halved text-neutral-500 dark:text-neutral-400"></i>
          <span><strong>Visitor Mode:</strong> Company directory is protected. Please log in or sign up to view and connect with companies.</span>
        </div>
        <div class="flex items-center gap-2">
          <button onclick="openAuthModal('login')" class="font-bold text-neutral-900 dark:text-white underline hover:opacity-80">
            Log In
          </button>
          <span class="text-neutral-400 dark:text-neutral-600">|</span>
          <button onclick="openAuthModal('register')" class="font-bold text-neutral-900 dark:text-white underline hover:opacity-80">
            Sign Up (Free)
          </button>
        </div>
      </div>
    `;
    banner.className = "border-b border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-950 block";
  }
}

/* ==========================================================================
   Render Category Pills
   ========================================================================== */
function renderCategories() {
  const container = document.getElementById('category-pills-container');
  if (!container) return;

  container.innerHTML = businessCategories.map(cat => {
    const isActive = state.activeCategory === cat.id;
    return `
      <button onclick="setCategory('${cat.id}')" class="cat-pill ${isActive ? 'active' : ''} px-4 py-2 rounded-full border text-xs font-semibold transition flex items-center gap-2 whitespace-nowrap ${isActive ? 'bg-black text-white dark:bg-white dark:text-black border-black dark:border-white' : 'border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:border-black dark:hover:border-white hover:text-black dark:hover:text-white'}">
        <i class="fa-solid ${cat.icon}"></i> ${cat.name}
      </button>
    `;
  }).join('');
}

window.setCategory = function(catId) {
  state.activeCategory = catId;
  renderCategories();
  renderBusinesses();
};

/* Render star rating HTML from numeric rating */
function renderStars(rating) {
  if (!rating) return '';
  const full  = Math.floor(rating);
  const half  = rating - full >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  let html = '<span class="stars-row flex items-center gap-0.5">';
  for (let i = 0; i < full;  i++) html += '<i class="fa-solid fa-star text-amber-400 text-[10px]"></i>';
  if (half)                        html += '<i class="fa-solid fa-star-half-stroke text-amber-400 text-[10px]"></i>';
  for (let i = 0; i < empty; i++) html += '<i class="fa-regular fa-star text-amber-300 dark:text-amber-600 text-[10px]"></i>';
  html += '</span>';
  return html;
}


/* ==========================================================================
   Render Business Cards with Sleek Compact Round Avatar
   ========================================================================== */
function renderBusinesses() {
  const grid = document.getElementById('business-grid');
  const countLabel = document.getElementById('results-count');
  if (!grid) return;

  let filtered = state.businesses.filter(biz => {
    // Bookmark filter
    if (state.bookmarkFilter && !state.bookmarkedIds.includes(biz.id)) return false;
    // Category filter
    if (state.activeCategory !== 'all' && biz.category !== state.activeCategory) return false;
    // Search filter
    if (state.searchQuery.trim() !== '') {
      const q = state.searchQuery.toLowerCase();
      const haystack = `${biz.businessName} ${biz.ownerName} ${biz.city} ${biz.country} ${biz.categoryLabel} ${biz.tagline} ${biz.description} ${biz.lookingFor} ${biz.offers}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  // Sorting
  if (state.sortBy === 'rating') {
    filtered = [...filtered].sort((a, b) => (b.rating || 0) - (a.rating || 0));
  } else if (state.sortBy === 'newest') {
    filtered = [...filtered].sort((a, b) => parseInt(b.establishedYear || 0) - parseInt(a.establishedYear || 0));
  }

  if (countLabel) {
    const sortLabel = state.sortBy === 'rating' ? ' · Sorted by Rating' : state.sortBy === 'newest' ? ' · Newest First' : '';
    const filterLabel = state.bookmarkFilter ? ' (Saved Only)' : '';
    countLabel.innerText = `Showing ${filtered.length} Active Companies${filterLabel}${sortLabel}`;
  }

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="col-span-full py-16 text-center rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-8 shadow-sm">
        <div class="w-14 h-14 mx-auto mb-3 rounded-full border border-dashed border-neutral-400 dark:border-neutral-600 flex items-center justify-center text-xl text-neutral-600 dark:text-neutral-400">
          <i class="fa-solid fa-building-circle-xmark"></i>
        </div>
        <h3 class="font-display font-bold text-lg text-neutral-900 dark:text-white mb-1">No companies found</h3>
        <p class="text-xs text-neutral-500 dark:text-neutral-400 max-w-sm mx-auto mb-4">Try searching for other keywords, cities like Surat, Rajkot, Ahmedabad, or reset filters.</p>
        <button onclick="resetAllFilters()" class="px-4 py-2 rounded-xl bg-black text-white dark:bg-white dark:text-black font-bold text-xs">
          View All Companies
        </button>
      </div>
    `;
    return;
  }

  const isSuperAdmin = state.currentUser && state.currentUser.role === 'super_admin';

  grid.innerHTML = filtered.map(biz => {
    const isBookmarked = state.bookmarkedIds.includes(biz.id);

    const encodedWaMsg = encodeURIComponent(
      `Hello ${biz.ownerName},\nI found your business "${biz.businessName}" (${biz.categoryLabel}) on Founder Business Connection.\n\nI am interested in connecting regarding: ${biz.lookingFor}.\nLet's discuss!`
    );
    const waLink = `https://wa.me/${biz.whatsapp ? biz.whatsapp.replace(/[^0-9]/g, '') : '919825000000'}?text=${encodedWaMsg}`;
    const mailLink = `mailto:${biz.email}?subject=${encodeURIComponent('Business Connection Inquiry: ' + biz.businessName)}&body=${encodedWaMsg}`;
    const phoneLink = `tel:${biz.phone}`;

    const coverImg = biz.businessImage || DEFAULT_COVER_PLACEHOLDER;
    const founderImg = biz.ownerAvatar || DEFAULT_AVATAR_PLACEHOLDER;

    return `
      <div class="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-sm flex flex-col justify-between group overflow-hidden transition hover:border-black dark:hover:border-white">
        <div>
          
          <!-- COVER PHOTO (INDUSTRY / FACTORY) -->
          <div class="relative h-24 sm:h-26 w-full overflow-hidden bg-neutral-200 dark:bg-neutral-800">
            <img src="${coverImg}" alt="${biz.businessName}" class="w-full h-full object-cover group-hover:scale-105 transition duration-500">
            <div class="absolute inset-0 bg-gradient-to-t from-black/60 via-black/10 to-transparent"></div>
            
            <!-- Top Badges on Cover -->
            <div class="absolute top-2.5 left-2.5 right-2.5 flex items-center justify-between">
              <span class="text-[10px] font-bold px-2 py-0.5 rounded-md bg-black/70 backdrop-blur-md text-white border border-white/20">
                <i class="fa-solid fa-tag text-[9px] mr-1"></i>${biz.categoryLabel}
              </span>

              <div class="flex items-center gap-1">
                ${biz.badge ? `<span class="text-[9px] font-bold px-1.5 py-0.5 rounded bg-white/95 text-black font-display shadow-sm">${biz.badge}</span>` : ''}

                ${isSuperAdmin ? `
                  <button onclick="handleAdminDeleteCompany('${biz.id}', '${biz.businessName.replace(/'/g, "\\'")}')" class="px-1.5 py-0.5 rounded bg-red-600 hover:bg-red-500 text-white text-[10px] font-bold shadow transition" title="Remove Company">
                    <i class="fa-solid fa-trash-can"></i>
                  </button>
                ` : ''}

                <button onclick="toggleBookmark('${biz.id}')" class="p-1 rounded bg-black/60 backdrop-blur-md text-white hover:bg-black text-xs transition ${isBookmarked ? 'text-amber-400' : ''}" title="Save Business">
                  <i class="fa-${isBookmarked ? 'solid' : 'regular'} fa-bookmark"></i>
                </button>
              </div>
            </div>

            <div class="absolute bottom-1.5 right-2.5 text-[10px] font-semibold text-white/90 flex items-center gap-1 bg-black/60 backdrop-blur-md px-2 py-0.5 rounded">
              <i class="fa-solid fa-location-dot text-[9px]"></i> ${biz.city}
            </div>
          </div>

          <!-- COMPACT ROUND PROFILE AVATAR -->
          <div class="px-4">
            <div class="flex items-end justify-between -mt-7 relative z-10 mb-2">
              
              <!-- Circular Profile Frame -->
              <div class="relative shrink-0">
                <img src="${founderImg}" alt="${biz.ownerName}" class="w-13 h-13 sm:w-14 sm:h-14 rounded-full object-cover ring-3 ring-white dark:ring-neutral-900 shadow-md bg-neutral-200 dark:bg-neutral-800">
                ${biz.verified ? '<span class="absolute bottom-0 right-0 bg-emerald-500 text-white text-[8px] w-3.5 h-3.5 rounded-full flex items-center justify-center border-2 border-white dark:border-neutral-900 shadow" title="Verified Founder"><i class="fa-solid fa-check"></i></span>' : ''}
              </div>
              
              <div class="text-right pb-0.5">
                <span class="text-[9px] font-bold text-neutral-500 dark:text-neutral-400 block">Est. ${biz.establishedYear || 'Verified'}</span>
                <span class="text-[11px] font-bold text-neutral-900 dark:text-white">${biz.annualTurnover || 'Active'}</span>
              </div>
            </div>

            <!-- Founder & Business Info -->
            <div class="mb-2.5">
              <h3 class="font-display font-bold text-base text-neutral-900 dark:text-white group-hover:underline cursor-pointer leading-tight truncate" onclick="openBusinessDetailModal('${biz.id}')" title="${biz.businessName}">
                ${biz.businessName}
              </h3>
              <p class="text-xs text-neutral-700 dark:text-neutral-300 font-semibold flex items-center gap-1 mt-0.5 truncate">
                <span>${biz.ownerName}</span> <span class="text-neutral-400">•</span> <span class="text-neutral-500 dark:text-neutral-400 font-normal text-[10px]">Founder</span>
              </p>
              ${biz.rating ? `
              <div class="flex items-center gap-1.5 mt-1">
                ${renderStars(biz.rating)}
                <span class="text-[10px] font-bold text-neutral-700 dark:text-neutral-300">${biz.rating.toFixed(1)}</span>
                <span class="text-[10px] text-neutral-400">(${biz.reviewCount || 0} reviews)</span>
              </div>` : ''}
              <p class="text-[11px] text-neutral-600 dark:text-neutral-400 font-medium mt-1 line-clamp-2 leading-relaxed">
                "${biz.tagline}"
              </p>
            </div>

            <!-- Compact Info Boxes -->
            <div class="space-y-1.5 mb-3 text-xs">
              <div class="p-2 rounded-xl border border-neutral-200 dark:border-neutral-700/60 bg-neutral-50 dark:bg-neutral-800/60">
                <span class="font-bold text-neutral-500 dark:text-neutral-400 block text-[9px] uppercase tracking-wider">Looking To Connect:</span>
                <span class="text-neutral-900 dark:text-white font-medium line-clamp-1">${biz.lookingFor}</span>
              </div>
              <div class="p-2 rounded-xl border border-neutral-200 dark:border-neutral-700/60 bg-neutral-50 dark:bg-neutral-800/60">
                <span class="font-bold text-neutral-500 dark:text-neutral-400 block text-[9px] uppercase tracking-wider">What We Offer:</span>
                <span class="text-neutral-800 dark:text-neutral-300 line-clamp-1">${biz.offers}</span>
              </div>
            </div>

          </div>
        </div>

          <!-- DIRECT CONNECT BAR -->
          <div class="p-4 pt-0">
            <div class="grid grid-cols-12 gap-2">
              <a href="${waLink}" target="_blank" rel="noopener noreferrer" id="wa-btn-${biz.id}" class="col-span-8 px-3 py-2 rounded-xl bg-[#25D366] text-white hover:opacity-90 font-bold text-xs flex items-center justify-center gap-1.5 transition shadow-sm" title="Chat Directly on WhatsApp">
                <i class="fa-brands fa-whatsapp text-sm"></i> Direct WhatsApp
              </a>
              <a href="${phoneLink}" class="col-span-2 px-3 py-2 rounded-xl border border-neutral-300 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800 hover:border-black dark:hover:border-white text-neutral-900 dark:text-white text-xs flex items-center justify-center transition" title="Call ${biz.phone}">
                <i class="fa-solid fa-phone"></i>
              </a>
              <a href="${mailLink}" class="col-span-2 px-3 py-2 rounded-xl border border-neutral-300 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800 hover:border-black dark:hover:border-white text-neutral-900 dark:text-white text-xs flex items-center justify-center transition" title="Send Email">
                <i class="fa-solid fa-envelope"></i>
              </a>
            </div>

            <button onclick="openInquiryModal('${biz.id}')" class="w-full mt-1.5 py-1.5 rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 hover:border-black dark:hover:border-white text-xs font-semibold text-neutral-600 dark:text-neutral-400 hover:text-black dark:hover:text-white transition flex items-center justify-center gap-1.5">
              <i class="fa-regular fa-paper-plane text-[10px]"></i> Send Detailed Inquiry
            </button>
          </div>
      </div>
    `;
  }).join('');
}

window.resetAllFilters = function() {
  state.activeCategory = 'all';
  state.searchQuery = '';
  state.bookmarkFilter = false;
  state.sortBy = 'default';
  const input = document.getElementById('search-box');
  if (input) input.value = '';
  const sortSel = document.getElementById('sort-select');
  if (sortSel) sortSel.value = 'default';
  updateBookmarkFilterBtn();
  renderCategories();
  renderBusinesses();
  showToast('Showing all companies');
};

window.toggleBookmarkFilter = function() {
  state.bookmarkFilter = !state.bookmarkFilter;
  updateBookmarkFilterBtn();
  renderBusinesses();
  showToast(state.bookmarkFilter ? '🔖 Showing saved companies only' : 'Showing all companies');
};

window.handleSortChange = function(val) {
  state.sortBy = val;
  renderBusinesses();
};

function updateBookmarkFilterBtn() {
  const btn = document.getElementById('bookmark-filter-btn');
  if (!btn) return;
  if (state.bookmarkFilter) {
    btn.classList.add('bg-black', 'text-white', 'dark:bg-white', 'dark:text-black', 'border-black', 'dark:border-white');
    btn.classList.remove('bg-white', 'dark:bg-neutral-900', 'text-neutral-600', 'dark:text-neutral-300');
    btn.innerHTML = '<i class="fa-solid fa-bookmark text-[11px]"></i> Saved';
  } else {
    btn.classList.remove('bg-black', 'text-white', 'dark:bg-white', 'dark:text-black', 'border-black', 'dark:border-white');
    btn.classList.add('bg-white', 'dark:bg-neutral-900', 'text-neutral-600', 'dark:text-neutral-300');
    btn.innerHTML = '<i class="fa-regular fa-bookmark text-[11px]"></i> Saved';
  }
};

/* ==========================================================================
   Admin Action: Manually Remove / Delete Company
   ========================================================================== */
window.handleAdminDeleteCompany = function(bizId, bizName) {
  if (!state.currentUser || state.currentUser.role !== 'super_admin') {
    showToast("⚠️ Permission denied.");
    return;
  }

  const confirmDelete = confirm(`Are you sure you want to permanently remove "${bizName}" from Founder Business Connection?`);
  if (!confirmDelete) return;

  state.deletedBizIds.push(bizId);
  localStorage.setItem('fbc_deleted_biz_ids', JSON.stringify(state.deletedBizIds));

  const customList = JSON.parse(localStorage.getItem('fbc_custom_businesses') || '[]');
  const updatedCustom = customList.filter(b => b.id !== bizId);
  localStorage.setItem('fbc_custom_businesses', JSON.stringify(updatedCustom));

  loadBusinesses();
  renderBusinesses();
  renderAuthBanner();
  showToast(`🗑️ "${bizName}" has been removed from the platform.`);
};

window.handleRestoreAllDeleted = function() {
  if (!state.currentUser || state.currentUser.role !== 'super_admin') return;

  const count = state.deletedBizIds.length;
  state.deletedBizIds = [];
  localStorage.removeItem('fbc_deleted_biz_ids');

  loadBusinesses();
  renderBusinesses();
  renderAuthBanner();
  showToast(`✅ Restored ${count} previously deleted companies.`);
};

/* ==========================================================================
   Bookmarks
   ========================================================================== */
window.toggleBookmark = function(id) {
  const idx = state.bookmarkedIds.indexOf(id);
  if (idx > -1) {
    state.bookmarkedIds.splice(idx, 1);
    showToast('Removed from saved list');
  } else {
    state.bookmarkedIds.push(id);
    showToast('Company saved to bookmarks');
  }
  localStorage.setItem('fbc_bookmarks', JSON.stringify(state.bookmarkedIds));
  renderBusinesses();
};

/* ==========================================================================
   Auth Modal (Login & Sign Up)
   ========================================================================== */
window.openAuthModal = function(tab = 'login') {
  state.authTab = tab;
  const modal = document.getElementById('main-modal');
  const body = document.getElementById('modal-body');
  if (!modal || !body) return;

  body.innerHTML = `
    <div class="space-y-4">
      
      <!-- Tab Header -->
      <div class="flex border-b border-neutral-200 dark:border-neutral-800">
        <button onclick="switchAuthTab('login')" class="auth-tab flex-1 text-center font-bold text-sm py-2 ${state.authTab === 'login' ? 'text-neutral-900 dark:text-white border-b-2 border-black dark:border-white' : 'text-neutral-500'}">
          <i class="fa-solid fa-arrow-right-to-bracket mr-1"></i> Log In
        </button>
        <button onclick="switchAuthTab('register')" class="auth-tab flex-1 text-center font-bold text-sm py-2 ${state.authTab === 'register' ? 'text-neutral-900 dark:text-white border-b-2 border-black dark:border-white' : 'text-neutral-500'}">
          <i class="fa-solid fa-user-plus mr-1"></i> Create Free Account
        </button>
      </div>

      <!-- Tab 1: Login Form -->
      <div id="auth-tab-login" class="${state.authTab === 'login' ? '' : 'hidden'} space-y-3 text-xs">
        
        <div id="login-error-msg" class="hidden p-2.5 rounded-xl bg-red-100 dark:bg-red-950/80 border border-red-300 dark:border-red-800 text-red-800 dark:text-red-200 text-xs font-semibold">
          <!-- Error text dynamically inserted -->
        </div>

        <form onsubmit="handleLoginSubmit(event)" class="space-y-3">
          <div>
            <label class="block font-bold text-neutral-800 dark:text-neutral-200 mb-1">Email or Mobile Number *</label>
            <input id="login-identifier" required type="text" class="w-full rounded-xl p-2.5 border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white placeholder-neutral-400 dark:placeholder-neutral-500 text-xs focus:outline-none focus:border-black dark:focus:border-white" placeholder="Enter your registered email or phone">
          </div>
          <div>
            <label class="block font-bold text-neutral-800 dark:text-neutral-200 mb-1">Password *</label>
            <input id="login-password" required type="password" class="w-full rounded-xl p-2.5 border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white placeholder-neutral-400 dark:placeholder-neutral-500 text-xs focus:outline-none focus:border-black dark:focus:border-white" placeholder="Enter your password">
          </div>

          <div class="pt-2 flex justify-between items-center">
            <span class="text-[11px] text-neutral-500">New here? <a href="javascript:void(0)" onclick="switchAuthTab('register')" class="text-neutral-900 dark:text-white font-bold underline">Sign Up</a></span>
            <div class="flex gap-2">
              <button type="button" onclick="closeMainModal()" class="px-4 py-2 rounded-xl border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:border-black dark:hover:border-white text-xs font-semibold">Cancel</button>
              <button type="submit" class="px-5 py-2 rounded-xl bg-black text-white dark:bg-white dark:text-black font-bold text-xs hover:opacity-90">
                Log In & Open Directory &rarr;
              </button>
            </div>
          </div>
        </form>
      </div>

      <!-- Tab 2: Basic Sign Up Form -->
      <div id="auth-tab-register" class="${state.authTab === 'register' ? '' : 'hidden'} space-y-3 text-xs">
        
        <div id="register-error-msg" class="hidden p-2.5 rounded-xl bg-red-100 dark:bg-red-950/80 border border-red-300 dark:border-red-800 text-red-800 dark:text-red-200 text-xs font-semibold">
          <!-- Error text dynamically inserted -->
        </div>

        <div class="p-2.5 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 text-[11px] text-neutral-600 dark:text-neutral-400">
          <i class="fa-solid fa-info-circle mr-1 text-neutral-900 dark:text-white"></i> Create your account to unlock the full company directory and connect with business owners.
        </div>

        <form onsubmit="handleRegisterSubmit(event)" class="space-y-3">
          <div>
            <label class="block font-bold text-neutral-800 dark:text-neutral-200 mb-1">Your Full Name *</label>
            <input id="reg-name" required type="text" class="w-full rounded-xl p-2.5 border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white placeholder-neutral-400 dark:placeholder-neutral-500 text-xs focus:outline-none focus:border-black dark:focus:border-white" placeholder="e.g. Jeel Patel">
          </div>

          <div>
            <label class="block font-bold text-neutral-800 dark:text-neutral-200 mb-1">Email Address *</label>
            <input id="reg-email" required type="email" class="w-full rounded-xl p-2.5 border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white placeholder-neutral-400 dark:placeholder-neutral-500 text-xs focus:outline-none focus:border-black dark:focus:border-white" placeholder="e.g. jeel@business.com">
          </div>

          <div>
            <label class="block font-bold text-neutral-800 dark:text-neutral-200 mb-1">Create Password *</label>
            <input id="reg-password" required minlength="8" type="password" oninput="updatePasswordStrengthMeter(this.value)" class="w-full rounded-xl p-2.5 border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white placeholder-neutral-400 dark:placeholder-neutral-500 text-xs focus:outline-none focus:border-black dark:focus:border-white" placeholder="Min 8 chars, UPPERCASE, number, symbol">
            <!-- Password Strength Meter -->
            <div class="mt-1.5 space-y-1">
              <div class="flex gap-1">
                <div id="psm-1" class="h-1 flex-1 rounded-full bg-neutral-200 dark:bg-neutral-700 transition-colors duration-300"></div>
                <div id="psm-2" class="h-1 flex-1 rounded-full bg-neutral-200 dark:bg-neutral-700 transition-colors duration-300"></div>
                <div id="psm-3" class="h-1 flex-1 rounded-full bg-neutral-200 dark:bg-neutral-700 transition-colors duration-300"></div>
                <div id="psm-4" class="h-1 flex-1 rounded-full bg-neutral-200 dark:bg-neutral-700 transition-colors duration-300"></div>
              </div>
              <p id="psm-label" class="text-[10px] text-neutral-400">8+ chars · Uppercase · Number · Symbol (!@#$%)</p>
            </div>
          </div>

          <div>
            <label class="block font-bold text-neutral-800 dark:text-neutral-200 mb-1">Confirm Password *</label>
            <input id="reg-confirm-password" required minlength="4" type="password" class="w-full rounded-xl p-2.5 border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white placeholder-neutral-400 dark:placeholder-neutral-500 text-xs focus:outline-none focus:border-black dark:focus:border-white" placeholder="Re-enter password">
          </div>

          <div class="pt-2 flex justify-end gap-2">
            <button type="button" onclick="closeMainModal()" class="px-4 py-2 rounded-xl border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:border-black dark:hover:border-white text-xs font-semibold">Cancel</button>
            <button type="submit" class="px-5 py-2 rounded-xl bg-black text-white dark:bg-white dark:text-black font-bold text-xs hover:opacity-90">
              Create Account & Unlock Directory &rarr;
            </button>
          </div>
        </form>
      </div>

    </div>
  `;

  modal.classList.remove('hidden');
};

window.switchAuthTab = function(tab) {
  openAuthModal(tab);
};

/* Live Password Strength Meter */
window.updatePasswordStrengthMeter = function(password) {
  const score = getPasswordStrengthScore(password);
  const colors = ['#ef4444', '#f97316', '#eab308', '#22c55e']; // red → orange → yellow → green
  const labels = [
    '8+ chars · Uppercase · Number · Symbol (!@#$%)',
    'Add an uppercase letter (A-Z)',
    'Add a number (0-9)',
    'Add a special character (!@#$%) — Strong! ✓'
  ];
  for (let i = 1; i <= 4; i++) {
    const seg = document.getElementById(`psm-${i}`);
    if (seg) {
      seg.style.backgroundColor = i <= score ? colors[score - 1] : '';
      seg.className = `h-1 flex-1 rounded-full transition-colors duration-300 ${i <= score ? '' : 'bg-neutral-200 dark:bg-neutral-700'}`;
    }
  }
  const label = document.getElementById('psm-label');
  if (label) {
    if (!password) {
      label.textContent = '8+ chars · Uppercase · Number · Symbol (!@#$%)';
      label.className = 'text-[10px] text-neutral-400';
    } else if (score < 4) {
      const hints = [];
      if (password.length < 8) hints.push('8+ chars');
      if (!/[A-Z]/.test(password)) hints.push('uppercase');
      if (!/[0-9]/.test(password)) hints.push('number');
      if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) hints.push('symbol');
      label.textContent = `Still needed: ${hints.join(', ')}`;
      label.className = 'text-[10px] text-amber-500 font-semibold';
    } else {
      label.textContent = '✓ Strong password!';
      label.className = 'text-[10px] text-green-500 font-semibold';
    }
  }
};

/* ==========================================================================
   Handle Login (Strict Validation)
   ========================================================================== */
window.handleLoginSubmit = async function(e) {
  e.preventDefault();
  const identifier = document.getElementById('login-identifier')?.value.trim() || '';
  const password = document.getElementById('login-password')?.value || '';
  const errorBox = document.getElementById('login-error-msg');
  const submitBtn = e.target.querySelector('button[type="submit"]');

  const showError = (msg) => {
    if (errorBox) {
      errorBox.innerHTML = `<i class="fa-solid fa-shield-halved mr-1"></i> ${msg}`;
      errorBox.classList.remove('hidden');
    }
    showToast('❌ ' + msg.replace(/<[^>]+>/g, ''));
  };

  if (!identifier) { showError('Please enter your email or phone.'); return; }

  const registeredUsers = getRegisteredUsers();

  const user = registeredUsers.find(u =>
    (u.email && u.email.toLowerCase() === identifier.toLowerCase()) ||
    (u.phone && u.phone.replace(/[^0-9]/g, '') === identifier.replace(/[^0-9]/g, ''))
  );

  if (!user) {
    showError(`No account found for <strong>${sanitize(identifier)}</strong>. Please sign up first.`);
    return;
  }

  /* ── Rate limiting check ── */
  const lockCheck = isAccountLocked(user.email);
  if (lockCheck.locked) {
    const mins = Math.ceil(lockCheck.remaining / 60);
    showError(`Account temporarily locked after too many failed attempts. Try again in <strong>${mins} minute${mins !== 1 ? 's' : ''}</strong>.`);
    return;
  }

  /* ── Disable button while hashing ── */
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Verifying...'; }

  const hashedInput = await sha256(password);

  if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = 'Log In & Open Directory &rarr;'; }

  if (user.password !== hashedInput) {
    recordFailedAttempt(user.email);
    const rl = getRateLimitState(user.email);
    const attemptsLeft = RATE_LIMIT_MAX - (rl.attempts || 0);
    const lockMsg = attemptsLeft <= 0
      ? 'Account locked for 5 minutes due to too many failed attempts.'
      : `Incorrect password. <strong>${attemptsLeft} attempt${attemptsLeft !== 1 ? 's' : ''}</strong> remaining before lockout.`;
    showError(lockMsg);
    return;
  }

  /* ── Success: clear rate limit, start session ── */
  clearFailedAttempts(user.email);
  state.currentUser = user;
  localStorage.setItem('fbc_current_user', JSON.stringify(user));
  localStorage.setItem('fbc_session_meta', JSON.stringify({ loginTime: Date.now() }));

  closeMainModal();
  renderAuthHeader();
  renderAuthBanner();
  renderCurrentView();

  if (user.role === 'super_admin') {
    showToast(`👑 Master Access Granted! Logged in as ${user.name}.`);
  } else {
    showToast(`✅ Welcome back, ${user.name}! Directory unlocked.`);
  }
};

/* ==========================================================================
   Handle Sign Up (Clean Start - No fake pre-filled faces)
   ========================================================================== */
window.handleRegisterSubmit = async function(e) {
  e.preventDefault();
  const name = document.getElementById('reg-name')?.value.trim() || 'Founder';
  const email = document.getElementById('reg-email')?.value.trim() || '';
  const password = document.getElementById('reg-password')?.value || '';
  const confirmPassword = document.getElementById('reg-confirm-password')?.value || '';
  const errorBox = document.getElementById('register-error-msg');
  const submitBtn = e.target.querySelector('button[type="submit"]');

  const showError = (msg) => {
    if (errorBox) {
      errorBox.innerHTML = `<i class="fa-solid fa-shield-halved mr-1"></i> ${msg}`;
      errorBox.classList.remove('hidden');
    }
    showToast('⚠️ ' + msg.replace(/<[^>]+>/g, ''));
  };

  /* ── Input validation ── */
  if (!name || name.length < 2) { showError('Please enter your full name (at least 2 characters).'); return; }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showError('Please enter a valid email address.'); return; }

  /* ── Password strength check ── */
  const strength = validatePasswordStrength(password);
  if (!strength.valid) { showError(strength.message); return; }

  if (password !== confirmPassword) {
    showError('Passwords do not match! Please verify your password.');
    return;
  }

  const registeredUsers = getRegisteredUsers();

  const existing = registeredUsers.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    showError(`An account with email <strong>${sanitize(email)}</strong> already exists. Please log in.`);
    return;
  }

  /* ── Hash password before storing ── */
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Creating Account...'; }
  const hashedPwd = await sha256(password);
  if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = 'Create Account & Unlock Directory &rarr;'; }

  const newUser = {
    id: `user-${Date.now()}`,
    name: sanitize(name),
    email: email.toLowerCase(),
    password: hashedPwd,       // stored as SHA-256 hash
    role: "client_founder",
    businessName: "",
    category: "textile",
    categoryLabel: "Textile & Garments",
    ownerAvatar: DEFAULT_AVATAR_PLACEHOLDER,
    businessImage: DEFAULT_COVER_PLACEHOLDER,
    city: "",
    phone: "",
    tagline: "",
    lookingFor: "",
    offers: "",
    profileCompleted: false,
    registeredAt: Date.now()
  };

  registeredUsers.push(newUser);
  saveRegisteredUsers(registeredUsers);

  state.currentUser = newUser;
  localStorage.setItem('fbc_current_user', JSON.stringify(newUser));
  localStorage.setItem('fbc_session_meta', JSON.stringify({ loginTime: Date.now() }));

  renderAuthHeader();
  renderAuthBanner();
  renderCurrentView();

  showToast(`🎉 Welcome ${newUser.name}! Please adjust & upload your photo.`);

  openProfileModal();
};

window.handleLogout = function() {
  state.currentUser = null;
  localStorage.removeItem('fbc_current_user');
  localStorage.removeItem('fbc_session_meta');
  renderAuthHeader();
  renderAuthBanner();
  renderCurrentView();
  showToast("🔒 Logged out securely. Session cleared.");
};

/* ==========================================================================
   INTERACTIVE IMAGE ADJUSTER & CROPPER MODAL (Drag, Zoom, Center)
   ========================================================================== */
window.handleAvatarFileChange = function(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(evt) {
    openCropModal(evt.target.result, 'avatar');
  };
  reader.readAsDataURL(file);
  e.target.value = ''; // Reset file input so re-selecting same file triggers change
};

window.handleCoverFileChange = function(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(evt) {
    openCropModal(evt.target.result, 'cover');
  };
  reader.readAsDataURL(file);
  e.target.value = ''; // Reset file input
};

window.openCropModal = function(dataUrl, mode = 'avatar') {
  cropState.active = true;
  cropState.mode = mode;
  cropState.imageSrc = dataUrl;
  cropState.scale = 1.0;
  cropState.rotation = 0;
  cropState.posX = 0;
  cropState.posY = 0;

  const cropModal = document.getElementById('crop-modal');
  const modalTitle = document.getElementById('crop-modal-title');
  const targetImg = document.getElementById('crop-target-img');
  const viewport = document.getElementById('crop-viewport');
  const maskGuide = document.getElementById('crop-mask-guide');
  const slider = document.getElementById('crop-zoom-slider');

  if (!cropModal || !targetImg || !viewport) return;

  if (slider) slider.value = 1.0;

  if (mode === 'avatar') {
    modalTitle.innerText = "Adjust & Position Profile Photo";
    // Circular viewport
    viewport.style.width = "220px";
    viewport.style.height = "220px";
    viewport.style.borderRadius = "9999px";
    if (maskGuide) {
      maskGuide.style.borderRadius = "9999px";
    }
  } else {
    modalTitle.innerText = "Adjust & Position Industry Cover Image";
    // Wide Rectangular Banner viewport
    viewport.style.width = "340px";
    viewport.style.height = "150px";
    viewport.style.borderRadius = "12px";
    if (maskGuide) {
      maskGuide.style.borderRadius = "12px";
    }
  }

  targetImg.src = dataUrl;
  targetImg.onload = function() {
    cropState.naturalWidth = targetImg.naturalWidth;
    cropState.naturalHeight = targetImg.naturalHeight;
    updateCropTransform();
  };

  cropModal.classList.remove('hidden');
};

window.closeCropModal = function() {
  const cropModal = document.getElementById('crop-modal');
  if (cropModal) cropModal.classList.add('hidden');
  cropState.active = false;
};

function updateCropTransform() {
  const img = document.getElementById('crop-target-img');
  if (!img) return;
  img.style.transform = `translate(${cropState.posX}px, ${cropState.posY}px) scale(${cropState.scale}) rotate(${cropState.rotation}deg)`;
}

function initCropDragListeners() {
  const viewport = document.getElementById('crop-viewport');
  const slider = document.getElementById('crop-zoom-slider');
  if (!viewport) return;

  // Mouse Dragging
  viewport.addEventListener('mousedown', (e) => {
    e.preventDefault();
    cropState.isDragging = true;
    cropState.startX = e.clientX - cropState.posX;
    cropState.startY = e.clientY - cropState.posY;
  });

  window.addEventListener('mousemove', (e) => {
    if (!cropState.isDragging || !cropState.active) return;
    cropState.posX = e.clientX - cropState.startX;
    cropState.posY = e.clientY - cropState.startY;
    updateCropTransform();
  });

  window.addEventListener('mouseup', () => {
    cropState.isDragging = false;
  });

  // Touch Dragging (Mobile)
  viewport.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      cropState.isDragging = true;
      cropState.startX = e.touches[0].clientX - cropState.posX;
      cropState.startY = e.touches[0].clientY - cropState.posY;
    }
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!cropState.isDragging || !cropState.active || e.touches.length !== 1) return;
    cropState.posX = e.touches[0].clientX - cropState.startX;
    cropState.posY = e.touches[0].clientY - cropState.startY;
    updateCropTransform();
  }, { passive: true });

  window.addEventListener('touchend', () => {
    cropState.isDragging = false;
  });

  // Slider Zoom Listener
  if (slider) {
    slider.addEventListener('input', (e) => {
      cropState.scale = parseFloat(e.target.value);
      updateCropTransform();
    });
  }
}

window.stepCropZoom = function(delta) {
  const slider = document.getElementById('crop-zoom-slider');
  let val = cropState.scale + delta;
  val = Math.max(0.5, Math.min(3.0, val));
  cropState.scale = parseFloat(val.toFixed(2));
  if (slider) slider.value = cropState.scale;
  updateCropTransform();
};

window.rotateCropImage = function() {
  cropState.rotation = (cropState.rotation + 90) % 360;
  updateCropTransform();
};

window.resetCropPosition = function() {
  cropState.scale = 1.0;
  cropState.rotation = 0;
  cropState.posX = 0;
  cropState.posY = 0;
  const slider = document.getElementById('crop-zoom-slider');
  if (slider) slider.value = 1.0;
  updateCropTransform();
};

window.applyCropImage = function() {
  const targetImg = document.getElementById('crop-target-img');
  const viewport = document.getElementById('crop-viewport');
  if (!targetImg || !viewport) return;

  const vWidth = viewport.clientWidth;
  const vHeight = viewport.clientHeight;

  // Offscreen Canvas
  const canvas = document.createElement('canvas');
  const outWidth = cropState.mode === 'avatar' ? 400 : 800;
  const outHeight = cropState.mode === 'avatar' ? 400 : Math.round(800 * (vHeight / vWidth));

  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, outWidth, outHeight);

  // Apply transforms to canvas
  ctx.save();
  ctx.translate(outWidth / 2, outHeight / 2);
  
  const scaleRatio = outWidth / vWidth;
  ctx.translate(cropState.posX * scaleRatio, cropState.posY * scaleRatio);
  ctx.scale(cropState.scale, cropState.scale);
  ctx.rotate((cropState.rotation * Math.PI) / 180);

  // Draw image scaled to fit initial viewport
  const imgAspect = targetImg.naturalWidth / targetImg.naturalHeight;
  const vpAspect = vWidth / vHeight;
  let drawW, drawH;

  if (imgAspect > vpAspect) {
    drawH = vHeight * scaleRatio;
    drawW = drawH * imgAspect;
  } else {
    drawW = vWidth * scaleRatio;
    drawH = drawW / imgAspect;
  }

  ctx.drawImage(targetImg, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();

  const croppedDataUrl = canvas.toDataURL('image/jpeg', 0.92);

  if (cropState.mode === 'avatar') {
    const previewAvatar = document.getElementById('preview-avatar');
    const previewAvatarImg = document.getElementById('preview-avatar-img');
    const inputUrl = document.getElementById('prof-avatar-url');

    if (previewAvatar) previewAvatar.src = croppedDataUrl;
    if (previewAvatarImg) previewAvatarImg.src = croppedDataUrl;
    if (inputUrl) inputUrl.value = croppedDataUrl;

    showToast("📸 Profile photo adjusted and applied!");
  } else {
    const previewCover = document.getElementById('preview-cover-img');
    const inputUrl = document.getElementById('prof-cover-url');

    if (previewCover) previewCover.src = croppedDataUrl;
    if (inputUrl) inputUrl.value = croppedDataUrl;

    showToast("🏭 Industry cover adjusted and applied!");
  }

  closeCropModal();
};

/* ==========================================================================
   Business Profile Management Modal ("My Business Profile")
   ========================================================================== */
window.openProfileModal = function() {
  if (!state.currentUser) {
    openAuthModal('login');
    return;
  }

  const user = state.currentUser;
  const progress = calculateProfileProgress(user);
  const modal = document.getElementById('main-modal');
  const body = document.getElementById('modal-body');
  if (!modal || !body) return;

  const currentAvatar = user.ownerAvatar || DEFAULT_AVATAR_PLACEHOLDER;
  const currentCover = user.businessImage || DEFAULT_COVER_PLACEHOLDER;

  body.innerHTML = `
    <div class="space-y-4 max-h-[82vh] overflow-y-auto pr-1">
      
      <!-- Modal Header -->
      <div class="border-b border-neutral-200 dark:border-neutral-800 pb-3">
        <div class="flex items-center justify-between mb-1">
          <span class="text-[11px] font-bold px-2.5 py-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200">
            <i class="fa-solid fa-id-card text-[10px] mr-1"></i> Founder Business Profile & Photos
          </span>
          <span class="text-xs font-bold ${progress >= 85 ? 'text-neutral-900 dark:text-white' : 'text-amber-600 dark:text-amber-400'}">
            ${progress}% Completed
          </span>
        </div>
        <h3 class="font-display font-extrabold text-xl text-neutral-900 dark:text-white">${user.name}</h3>
        <p class="text-xs text-neutral-500 dark:text-neutral-400">${user.email || 'Verified Account'}</p>

        <!-- Progress Bar -->
        <div class="mt-2.5 bg-neutral-200 dark:bg-neutral-800 h-2 rounded-full overflow-hidden border border-neutral-300 dark:border-neutral-700">
          <div class="bg-neutral-900 dark:bg-white h-full rounded-full transition-all duration-300" style="width: ${progress}%"></div>
        </div>
      </div>

      <!-- LIVE PREVIEW BOX -->
      <div class="rounded-2xl border border-neutral-200 dark:border-neutral-700 overflow-hidden bg-white dark:bg-neutral-900 shadow-sm">
        <div class="relative h-22 w-full bg-neutral-200 dark:bg-neutral-800">
          <img id="preview-cover-img" src="${currentCover}" class="w-full h-full object-cover">
          <span class="absolute top-2 right-2 text-[9px] bg-black/70 backdrop-blur-md text-white px-2 py-0.5 rounded font-semibold">Your Industry Cover</span>
        </div>
        <div class="px-4 pb-2.5 flex items-end justify-between -mt-7 relative z-10">
          <div class="flex items-end gap-2.5">
            <img id="preview-avatar-img" src="${currentAvatar}" class="w-14 h-14 rounded-full object-cover ring-3 ring-white dark:ring-neutral-900 shadow-md bg-neutral-200 dark:bg-neutral-800">
            <div class="pb-0.5">
              <span class="font-bold text-xs text-neutral-900 dark:text-white block" id="preview-name-label">${user.name}</span>
              <span class="text-[10px] text-neutral-500 dark:text-neutral-400 block" id="preview-biz-label">${user.businessName || 'Your Business Name'}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Business Profile Form -->
      <form onsubmit="handleProfileUpdateSubmit(event)" class="space-y-3.5 text-xs">
        
        <!-- DEVICE PHOTO UPLOAD SECTION WITH ADJUST/CROP -->
        <div class="p-3.5 rounded-2xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900/90 space-y-3">
          
          <!-- 1. Real Profile Photo Upload with Position Adjuster -->
          <div>
            <label class="block font-bold text-neutral-800 dark:text-neutral-200 mb-1.5">
              <i class="fa-solid fa-user-circle mr-1"></i> Your Profile Photo (Founder Avatar)
            </label>
            
            <div class="flex items-center gap-3">
              <img id="preview-avatar" src="${currentAvatar}" class="w-13 h-13 rounded-full object-cover border-2 border-neutral-300 dark:border-neutral-700 shadow-sm shrink-0 bg-neutral-200 dark:bg-neutral-800">
              
              <div class="flex-1 space-y-1.5">
                <input type="file" id="prof-avatar-file" accept="image/*" onchange="handleAvatarFileChange(event)" class="hidden">
                
                <button type="button" onclick="document.getElementById('prof-avatar-file').click()" class="w-full sm:w-auto px-3.5 py-1.5 rounded-xl border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 hover:border-black dark:hover:border-white font-bold text-xs text-neutral-900 dark:text-white flex items-center justify-center gap-1.5 shadow-sm transition">
                  <i class="fa-solid fa-crop-simple text-xs"></i> Choose & Adjust Photo from Device
                </button>

                <input id="prof-avatar-url" type="hidden" value="${user.ownerAvatar || ''}">
              </div>
            </div>
          </div>

          <!-- 2. Real Industry / Factory Cover Image Upload with Position Adjuster -->
          <div class="pt-2.5 border-t border-neutral-200 dark:border-neutral-800">
            <label class="block font-bold text-neutral-800 dark:text-neutral-200 mb-1.5">
              <i class="fa-solid fa-industry mr-1"></i> Your Industry / Factory / Workshop Cover Image
            </label>
            
            <div class="space-y-1.5">
              <input type="file" id="prof-cover-file" accept="image/*" onchange="handleCoverFileChange(event)" class="hidden">
              
              <button type="button" onclick="document.getElementById('prof-cover-file').click()" class="w-full sm:w-auto px-3.5 py-1.5 rounded-xl border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 hover:border-black dark:hover:border-white font-bold text-xs text-neutral-900 dark:text-white flex items-center justify-center gap-1.5 shadow-sm transition">
                <i class="fa-solid fa-camera text-xs"></i> Choose & Adjust Industry Cover from Device
              </button>

              <input id="prof-cover-url" type="hidden" value="${user.businessImage || ''}">
            </div>
          </div>

        </div>
        
        <!-- GENERAL DETAILS -->
        <div>
          <label class="block font-bold text-neutral-800 dark:text-neutral-200 mb-1">Your Full Name *</label>
          <input id="prof-name" required type="text" value="${user.name || ''}" oninput="document.getElementById('preview-name-label').innerText = this.value" class="w-full rounded-xl p-2.5 border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white text-xs focus:outline-none focus:border-black dark:focus:border-white">
        </div>

        <div>
          <label class="block font-bold text-neutral-800 dark:text-neutral-200 mb-1">Business / Firm / Company Name *</label>
          <input id="prof-business" required type="text" value="${user.businessName || ''}" oninput="document.getElementById('preview-biz-label').innerText = this.value" class="w-full rounded-xl p-2.5 border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white placeholder-neutral-400 dark:placeholder-neutral-500 text-xs focus:outline-none focus:border-black dark:focus:border-white" placeholder="e.g. Mahavir Textiles & Export">
        </div>

        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block font-bold text-neutral-800 dark:text-neutral-200 mb-1">Industry Sector *</label>
            <select id="prof-category" class="w-full rounded-xl p-2.5 border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white text-xs focus:outline-none focus:border-black dark:focus:border-white">
              <option value="textile" ${user.category === 'textile' ? 'selected' : ''}>Textile & Garments</option>
              <option value="manufacturing" ${user.category === 'manufacturing' ? 'selected' : ''}>Manufacturing & Industrial</option>
              <option value="food_fmcg" ${user.category === 'food_fmcg' ? 'selected' : ''}>Food, Spices & FMCG</option>
              <option value="import_export" ${user.category === 'import_export' ? 'selected' : ''}>Import & Export</option>
              <option value="construction" ${user.category === 'construction' ? 'selected' : ''}>Construction & Real Estate</option>
              <option value="retail_wholesale" ${user.category === 'retail_wholesale' ? 'selected' : ''}>Retail & Wholesale</option>
              <option value="agriculture" ${user.category === 'agriculture' ? 'selected' : ''}>Agriculture & Dairy</option>
              <option value="healthcare" ${user.category === 'healthcare' ? 'selected' : ''}>Pharma & Healthcare</option>
              <option value="services" ${user.category === 'services' ? 'selected' : ''}>Professional Services</option>
              <option value="tech" ${user.category === 'tech' ? 'selected' : ''}>Tech & Software</option>
            </select>
          </div>
          <div>
            <label class="block font-bold text-neutral-800 dark:text-neutral-200 mb-1">City & State *</label>
            <input id="prof-city" required type="text" value="${user.city || ''}" class="w-full rounded-xl p-2.5 border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white placeholder-neutral-400 dark:placeholder-neutral-500 text-xs focus:outline-none focus:border-black dark:focus:border-white" placeholder="e.g. Surat, Gujarat">
          </div>
        </div>

        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block font-bold text-neutral-800 dark:text-neutral-200 mb-1">WhatsApp / Phone *</label>
            <input id="prof-phone" required type="tel" value="${user.phone || ''}" class="w-full rounded-xl p-2.5 border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white placeholder-neutral-400 dark:placeholder-neutral-500 text-xs focus:outline-none focus:border-black dark:focus:border-white" placeholder="e.g. +91 98250 12345">
          </div>
          <div>
            <label class="block font-bold text-neutral-800 dark:text-neutral-200 mb-1">Email Address</label>
            <input id="prof-email" type="email" value="${user.email || ''}" class="w-full rounded-xl p-2.5 border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white placeholder-neutral-400 dark:placeholder-neutral-500 text-xs">
          </div>
        </div>

        <div>
          <label class="block font-bold text-neutral-800 dark:text-neutral-200 mb-1">1-Line Business Headline / Tagline *</label>
          <input id="prof-tagline" required type="text" value="${user.tagline || ''}" class="w-full rounded-xl p-2.5 border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white placeholder-neutral-400 dark:placeholder-neutral-500 text-xs focus:outline-none focus:border-black dark:focus:border-white" placeholder="e.g. Manufacturer of Rayon fabrics, digital printed sarees & wholesale kurtis.">
        </div>

        <div>
          <label class="block font-bold text-neutral-800 dark:text-neutral-200 mb-1">Who do you want to connect with? (Looking For) *</label>
          <input id="prof-looking" required type="text" value="${user.lookingFor || ''}" class="w-full rounded-xl p-2.5 border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white placeholder-neutral-400 dark:placeholder-neutral-500 text-xs focus:outline-none focus:border-black dark:focus:border-white" placeholder="e.g. Pan-India Wholesalers, Garment Exporters, Raw Material Suppliers">
        </div>

        <div>
          <label class="block font-bold text-neutral-800 dark:text-neutral-200 mb-1">What do you produce / offer? *</label>
          <input id="prof-offers" required type="text" value="${user.offers || ''}" class="w-full rounded-xl p-2.5 border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white placeholder-neutral-400 dark:placeholder-neutral-500 text-xs focus:outline-none focus:border-black dark:focus:border-white" placeholder="e.g. Factory wholesale rates, custom designs, 40,000 meter daily capacity.">
        </div>

        <div class="pt-3 border-t border-neutral-200 dark:border-neutral-800 flex justify-end gap-2">
          <button type="button" onclick="closeMainModal()" class="px-4 py-2 rounded-xl border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 text-xs font-semibold">Close</button>
          <button type="submit" class="px-5 py-2 rounded-xl bg-black text-white dark:bg-white dark:text-black font-bold text-xs hover:opacity-90">
            <i class="fa-solid fa-check mr-1"></i> Save & Publish Profile
          </button>
        </div>

      </form>
    </div>
  `;

  modal.classList.remove('hidden');
};

window.handleProfileUpdateSubmit = function(e) {
  e.preventDefault();
  const name = document.getElementById('prof-name')?.value.trim() || state.currentUser.name;
  const businessName = document.getElementById('prof-business')?.value.trim() || '';
  const category = document.getElementById('prof-category')?.value || 'textile';
  const city = document.getElementById('prof-city')?.value.trim() || '';
  const phone = document.getElementById('prof-phone')?.value.trim() || '';
  const email = document.getElementById('prof-email')?.value.trim() || state.currentUser.email;
  const tagline = document.getElementById('prof-tagline')?.value.trim() || '';
  const looking = document.getElementById('prof-looking')?.value.trim() || '';
  const offers = document.getElementById('prof-offers')?.value.trim() || '';
  const avatar = document.getElementById('prof-avatar-url')?.value.trim() || state.currentUser.ownerAvatar || DEFAULT_AVATAR_PLACEHOLDER;
  const coverImg = document.getElementById('prof-cover-url')?.value.trim() || state.currentUser.businessImage || DEFAULT_COVER_PLACEHOLDER;

  const catObj = businessCategories.find(c => c.id === category) || { name: 'Business' };

  const updatedUser = {
    ...state.currentUser,
    name: name,
    email: email,
    businessName: businessName,
    category: category,
    categoryLabel: catObj.name,
    city: city,
    phone: phone,
    tagline: tagline,
    lookingFor: looking,
    offers: offers,
    ownerAvatar: avatar,
    businessImage: coverImg,
    profileCompleted: true
  };

  state.currentUser = updatedUser;
  localStorage.setItem('fbc_current_user', JSON.stringify(updatedUser));

  const registeredUsers = getRegisteredUsers();
  const userIdx = registeredUsers.findIndex(u => u.email === updatedUser.email || u.id === updatedUser.id);
  if (userIdx > -1) {
    registeredUsers[userIdx] = { ...registeredUsers[userIdx], ...updatedUser };
  } else {
    registeredUsers.push(updatedUser);
  }
  saveRegisteredUsers(registeredUsers);

  const newBiz = {
    id: `biz-user-${state.currentUser.id || Date.now()}`,
    businessName: businessName,
    ownerName: name,
    category: category,
    categoryLabel: catObj.name,
    city: city,
    country: "India",
    tagline: tagline,
    description: tagline,
    lookingFor: looking,
    offers: offers,
    ownerAvatar: avatar,
    businessImage: coverImg,
    phone: phone,
    whatsapp: phone.replace(/[^0-9]/g, ''),
    email: email,
    establishedYear: new Date().getFullYear().toString(),
    annualTurnover: "Active Firm",
    verified: true,
    badge: "Verified Member"
  };

  const customList = JSON.parse(localStorage.getItem('fbc_custom_businesses') || '[]');
  const filteredList = customList.filter(b => b.ownerName !== name && b.businessName !== businessName);
  filteredList.unshift(newBiz);
  localStorage.setItem('fbc_custom_businesses', JSON.stringify(filteredList));

  loadBusinesses();
  closeMainModal();
  renderAuthHeader();
  renderAuthBanner();
  renderBusinesses();

  showToast(`🎉 Profile for "${businessName}" published with your adjusted photos!`);
};

/* ==========================================================================
   Business Detail & Direct Inquiry Modals
   ========================================================================== */
window.openBusinessDetailModal = function(bizId) {
  const biz = state.businesses.find(b => b.id === bizId);
  const modal = document.getElementById('main-modal');
  const body = document.getElementById('modal-body');
  if (!modal || !body || !biz) return;

  const encodedWaMsg = encodeURIComponent(`Hello ${biz.ownerName}, I saw ${biz.businessName} on Founder Business Connection and want to connect.`);
  const coverImg = biz.businessImage || DEFAULT_COVER_PLACEHOLDER;
  const founderImg = biz.ownerAvatar || DEFAULT_AVATAR_PLACEHOLDER;

  body.innerHTML = `
    <div class="space-y-4 max-h-[82vh] overflow-y-auto pr-1">
      
      <!-- Facebook Style Cover + Compact Round Avatar Header in Modal -->
      <div class="relative h-28 -mx-6 -mt-6 overflow-hidden rounded-t-2xl bg-neutral-200 dark:bg-neutral-800">
        <img src="${coverImg}" class="w-full h-full object-cover">
        <div class="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent"></div>
        <div class="absolute top-3 right-3">
          <span class="text-[10px] font-bold px-2 py-0.5 rounded bg-white text-black">${biz.categoryLabel}</span>
        </div>
      </div>

      <div class="flex items-end justify-between -mt-8 relative z-10 mb-2">
        <div class="flex items-end gap-2.5">
          <img src="${founderImg}" class="w-13 h-13 rounded-full object-cover ring-3 ring-white dark:ring-neutral-950 shadow-md bg-neutral-200 dark:bg-neutral-800">
          <div class="pb-0.5">
            <h3 class="font-display font-extrabold text-lg text-neutral-900 dark:text-white leading-tight">${biz.businessName}</h3>
            <p class="text-xs text-neutral-600 dark:text-neutral-400">Founder: <strong class="text-neutral-900 dark:text-white">${biz.ownerName}</strong> &nbsp;•&nbsp; ${biz.city}</p>
          </div>
        </div>
      </div>

      <div class="text-xs text-neutral-700 dark:text-neutral-300 space-y-2">
        <p class="text-sm font-bold text-neutral-900 dark:text-white">"${biz.tagline}"</p>
        <p class="leading-relaxed">${biz.description}</p>
      </div>

      <div class="grid grid-cols-2 gap-3 text-xs pt-1">
        <div class="p-3 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/60">
          <span class="text-neutral-500 dark:text-neutral-400 block font-bold uppercase text-[10px]">What They Need:</span>
          <span class="text-neutral-900 dark:text-white font-medium">${biz.lookingFor}</span>
        </div>
        <div class="p-3 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/60">
          <span class="text-neutral-500 dark:text-neutral-400 block font-bold uppercase text-[10px]">What They Supply:</span>
          <span class="text-neutral-900 dark:text-white font-medium">${biz.offers}</span>
        </div>
      </div>

      <!-- Contact Section -->
      <div class="pt-3 border-t border-neutral-200 dark:border-neutral-800 flex flex-col gap-2">
        <a href="https://wa.me/${biz.whatsapp ? biz.whatsapp.replace(/[^0-9]/g, '') : '919825000000'}?text=${encodedWaMsg}" target="_blank" class="px-4 py-3 rounded-xl bg-black text-white dark:bg-white dark:text-black font-bold text-xs flex items-center justify-center gap-2 hover:opacity-90 transition shadow-sm">
          <i class="fa-brands fa-whatsapp text-lg"></i> Direct Connect on WhatsApp (${biz.phone})
        </a>
        <div class="grid grid-cols-2 gap-2">
          <a href="tel:${biz.phone}" class="px-3 py-2.5 rounded-xl border border-neutral-300 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800 hover:border-black dark:hover:border-white text-neutral-900 dark:text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition">
            <i class="fa-solid fa-phone"></i> Call ${biz.phone}
          </a>
          <a href="mailto:${biz.email}" class="px-3 py-2.5 rounded-xl border border-neutral-300 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800 hover:border-black dark:hover:border-white text-neutral-900 dark:text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition">
            <i class="fa-solid fa-envelope"></i> Send Email
          </a>
        </div>
      </div>
    </div>
  `;

  modal.classList.remove('hidden');
};

window.openInquiryModal = function(bizId) {
  const biz = state.businesses.find(b => b.id === bizId);
  const modal = document.getElementById('main-modal');
  const body = document.getElementById('modal-body');
  if (!modal || !body || !biz) return;

  const senderName = state.currentUser
    ? `${state.currentUser.name}${state.currentUser.businessName ? ' – ' + state.currentUser.businessName : ''}`
    : '';
  const senderPhone = state.currentUser?.phone || '';
  const senderCity  = state.currentUser?.city  || '';

  body.innerHTML = `
    <div class="space-y-4">
      <div class="border-b border-neutral-200 dark:border-neutral-800 pb-3">
        <span class="text-[11px] font-bold px-2.5 py-0.5 rounded border border-neutral-300 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200 mb-1 inline-block">Direct Inquiry via WhatsApp</span>
        <h3 class="font-display font-bold text-xl text-neutral-900 dark:text-white">Connect with ${biz.businessName}</h3>
        <p class="text-xs text-neutral-500 dark:text-neutral-400">Owner: ${biz.ownerName} &nbsp;•&nbsp; ${biz.city}</p>
      </div>

      <form onsubmit="handleSendInquiry(event, '${biz.id}')" class="space-y-3 text-xs">
        <div>
          <label class="block font-bold text-neutral-800 dark:text-neutral-200 mb-1">Your Name &amp; Business</label>
          <input id="inq-sender" required type="text" value="${senderName}" class="w-full rounded-xl p-2.5 border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white text-xs focus:outline-none focus:border-black dark:focus:border-white">
        </div>

        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block font-bold text-neutral-800 dark:text-neutral-200 mb-1">Your WhatsApp Number</label>
            <input id="inq-phone" required type="tel" value="${senderPhone}" class="w-full rounded-xl p-2.5 border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white placeholder-neutral-400 dark:placeholder-neutral-500 text-xs focus:outline-none focus:border-black dark:focus:border-white" placeholder="+91 98765 43210">
          </div>
          <div>
            <label class="block font-bold text-neutral-800 dark:text-neutral-200 mb-1">Your City</label>
            <input id="inq-city" required type="text" value="${senderCity}" class="w-full rounded-xl p-2.5 border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white placeholder-neutral-400 dark:placeholder-neutral-500 text-xs focus:outline-none focus:border-black dark:focus:border-white">
          </div>
        </div>

        <div>
          <label class="block font-bold text-neutral-800 dark:text-neutral-200 mb-1">Your Requirement / Proposal</label>
          <textarea id="inq-message" required rows="3" class="w-full rounded-xl p-2.5 border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white placeholder-neutral-400 dark:placeholder-neutral-500 text-xs focus:outline-none focus:border-black dark:focus:border-white" placeholder="Describe your order volume, supply requirement, or partnership proposal..."></textarea>
        </div>

        <div class="p-2.5 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 text-[11px] text-neutral-500 dark:text-neutral-400 flex items-center gap-2">
          <i class="fa-brands fa-whatsapp text-[#25D366] text-base"></i>
          Your inquiry will open directly on WhatsApp with a pre-filled message to <strong class="text-neutral-800 dark:text-neutral-200">${biz.ownerName}</strong>.
        </div>

        <div class="pt-2 flex justify-end gap-2">
          <button type="button" onclick="closeMainModal()" class="px-4 py-2 rounded-xl border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 text-xs font-semibold">Cancel</button>
          <button type="submit" class="px-5 py-2 rounded-xl bg-[#25D366] text-white font-bold text-xs hover:opacity-90 flex items-center gap-1.5">
            <i class="fa-brands fa-whatsapp"></i> Open WhatsApp &rarr;
          </button>
        </div>
      </form>
    </div>
  `;

  modal.classList.remove('hidden');
};

window.openListBusinessModal = function() {
  openProfileModal();
};

window.closeMainModal = function() {
  const modal = document.getElementById('main-modal');
  if (modal) modal.classList.add('hidden');
};

/* ==========================================================================
   Form Submissions Handlers
   ========================================================================= */
window.handleSendInquiry = function(e, bizId) {
  e.preventDefault();
  const biz = state.businesses.find(b => b.id === bizId);
  if (!biz) return;

  const sender  = document.getElementById('inq-sender')?.value.trim()   || 'A business contact';
  const phone   = document.getElementById('inq-phone')?.value.trim()    || '';
  const city    = document.getElementById('inq-city')?.value.trim()     || '';
  const message = document.getElementById('inq-message')?.value.trim() || '';

  const waText = encodeURIComponent(
    `Hello ${biz.ownerName},\n\nI found your business *${biz.businessName}* on Founder Business Connection and would like to connect.\n\n` +
    `*My Details:*\nName/Business: ${sender}\nPhone: ${phone}\nCity: ${city}\n\n` +
    `*My Requirement:*\n${message}\n\nLooking forward to connecting!`
  );

  const waNumber = (biz.whatsapp || '').replace(/[^0-9]/g, '');
  const waUrl = `https://wa.me/${waNumber || '919825000000'}?text=${waText}`;

  closeMainModal();
  window.open(waUrl, '_blank', 'noopener,noreferrer');
  showToast(`✅ Opening WhatsApp to connect with ${biz.ownerName}!`);
};

/* ==========================================================================
   Toast Notifications
   ========================================================================== */
window.showToast = function(message) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast-item';
  toast.innerHTML = `<div class="flex items-center gap-2"><i class="fa-solid fa-check text-xs"></i> <span>${message}</span></div>`;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.2s ease';
    setTimeout(() => toast.remove(), 200);
  }, 3500);
};

/* ==========================================================================
   Search Input Handler
   ========================================================================== */
function setupEventListeners() {
  const searchBox = document.getElementById('search-box');
  if (searchBox) {
    let timer = null;
    searchBox.addEventListener('input', (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.searchQuery = e.target.value;
        renderBusinesses();
      }, 200);
    });
  }

  document.querySelectorAll('.quick-tag').forEach(tag => {
    tag.addEventListener('click', () => {
      const query = tag.getAttribute('data-query');
      if (searchBox) {
        searchBox.value = query;
        state.searchQuery = query;
        renderBusinesses();
      }
    });
  });
}
