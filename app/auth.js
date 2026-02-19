(function () {
    'use strict';
    const AUTH_TOKEN_KEY = 'megamix_token';
    const PREVIEW_KEY = 'megamix_preview';
    const overlay = document.getElementById('auth-overlay');
    const loginForm = document.getElementById('login-form');
    const loginLicense = document.getElementById('login-license');
    const btnFreeTrial = document.getElementById('btn-free-trial');
    const btnSignin = document.getElementById('btn-signin');
    const loginPreviewWrap = document.getElementById('login-preview-wrap');

    function getBaseUrl() {
        if (typeof window !== 'undefined' && window.location && window.location.origin) {
            return window.location.origin;
        }
        return '';
    }

    function setPreviewMode(on) {
        try {
            if (on) sessionStorage.setItem(PREVIEW_KEY, '1');
            else sessionStorage.removeItem(PREVIEW_KEY);
        } catch (e) {}
    }

    function isPreviewMode() {
        try {
            return sessionStorage.getItem(PREVIEW_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    function setLoggedIn(loggedIn) {
        if (overlay) overlay.classList.toggle('hidden', !!loggedIn);
        if (btnSignin) {
            btnSignin.textContent = loggedIn ? 'Sign out' : 'Sign in';
        }
        if (document.body) {
            if (loggedIn) document.body.classList.add('logged-in');
            else document.body.classList.remove('logged-in');
        }
    }

    function setRequiredMode(required) {
        if (loginPreviewWrap) loginPreviewWrap.classList.toggle('hidden', !!required);
    }

    function getToken() {
        try {
            return localStorage.getItem(AUTH_TOKEN_KEY);
        } catch (e) {
            return null;
        }
    }

    function setToken(token) {
        try {
            if (token) localStorage.setItem(AUTH_TOKEN_KEY, token);
            else localStorage.removeItem(AUTH_TOKEN_KEY);
        } catch (e) {}
    }

    async function checkAuth() {
        const token = getToken();
        if (token) {
            try {
                const res = await fetch(getBaseUrl() + '/api/auth/me', {
                    headers: { Authorization: 'Bearer ' + token }
                });
                if (res.ok) {
                    setPreviewMode(false);
                    setLoggedIn(true);
                    setRequiredMode(false);
                    return;
                }
            } catch (e) {
                console.warn('Auth check failed', e);
            }
            setToken(null);
        }
        if (isPreviewMode()) {
            setLoggedIn(true);
            setRequiredMode(false);
            return;
        }
        setLoggedIn(false);
        setRequiredMode(false);
    }

    async function doLogin(email, licenseKey) {
        try {
            const res = await fetch(getBaseUrl() + '/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email || '', licenseKey: licenseKey || '' })
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.token) {
                setToken(data.token);
                setPreviewMode(false);
                setLoggedIn(true);
                setRequiredMode(false);
                if (loginForm) loginForm.reset();
                try {
                    window.dispatchEvent(new CustomEvent('megamix:logged-in'));
                } catch (e) {}
                return true;
            }
            alert(data.error || 'Login failed. Check your license key.');
            return false;
        } catch (e) {
            console.error('Login error', e);
            alert('Network error. Please try again.');
            return false;
        }
    }

    function showLoginRequired() {
        if (overlay) overlay.classList.remove('hidden');
        setRequiredMode(true);
    }

    async function doFreeTrial() {
        try {
            const res = await fetch(getBaseUrl() + '/create-checkout-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ priceId: '1mo' })
            });
            const data = await res.json().catch(() => ({}));
            if (data.url) {
                window.location.href = data.url;
                return;
            }
            alert(data.error || 'Could not start checkout.');
        } catch (e) {
            console.error('Checkout error', e);
            alert('Network error. Please try again.');
        }
    }

    function init() {
        if (!overlay) return;
        checkAuth();

        if (loginForm) {
            loginForm.addEventListener('submit', async function (e) {
                e.preventDefault();
                const licenseKey = loginLicense ? loginLicense.value.trim() : '';
                await doLogin('', licenseKey);
            });
        }
        if (btnFreeTrial) {
            btnFreeTrial.addEventListener('click', function () {
                doFreeTrial();
            });
        }
        var btnPreviewFree = document.getElementById('btn-preview-free');
        if (btnPreviewFree) {
            btnPreviewFree.addEventListener('click', function () {
                setToken(null);
                setPreviewMode(true);
                setLoggedIn(true);
                setRequiredMode(false);
            });
        }
        if (btnSignin) {
            btnSignin.addEventListener('click', function () {
                const token = getToken();
                if (token) {
                    setToken(null);
                    setLoggedIn(false);
                } else {
                    setPreviewMode(false);
                    setLoggedIn(false);
                }
            });
        }

        var footerFreeTrial = document.getElementById('footer-free-trial');
        if (footerFreeTrial) {
            footerFreeTrial.addEventListener('click', function (e) {
                e.preventDefault();
                doFreeTrial();
            });
        }
        window.MegaMixAuth = {
            showLoginRequired: showLoginRequired,
            isPreviewMode: isPreviewMode,
            getToken: getToken,
            doFreeTrial: doFreeTrial
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
