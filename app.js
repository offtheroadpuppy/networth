// --- ИНИЦИАЛИЗАЦИЯ ИНДИКАТОРА СТАТУСА ---
window.updateStatus = function(text) {
    const el = document.getElementById('sync-status');
    if (el) el.innerText = text;
};

// --- СОСТОЯНИЕ ПРИЛОЖЕНИЯ (State) ---
// Полная база кодов и символов мировых валют для выбора
const currencyDictionary = {
    "RUB": "RUB (₽)", "USD": "USD ($)", "EUR": "EUR (€)", "CNY": "CNY (¥)",
    "GBP": "GBP (£)", "JPY": "JPY (¥)", "CHF": "CHF (₣)", "CAD": "CAD ($)",
    "AUD": "AUD ($)", "AED": "AED (د.إ)", "KZT": "KZT (₸)", "BYN": "BYN (Br)",
    "AMD": "AMD (֏)", "GEL": "GEL (₾)", "TRY": "TRY (₺)", "THB": "THB (฿)"
};

let state = {
    userUid: null,
    finances: [],
    directories: {
        baseCurrency: 'RUB',
        currencies: ['RUB', 'USD', 'EUR', 'CNY'],
        types: ['Вклад', 'Наличные', 'Брокерский счет', 'Криптовалюта'],
        orgs: ['Сбербанк', 'Т-Банк', 'Binance', 'Сейф']
    },
    rates: { USD: 95, EUR: 102, CNY: 13, RUB: 1 },
    rateAutoMode: true,
    pivotConfig: { row1: 'type', row2: 'none', date: 'ALL' },
    customCharts: [
        { id: 1, source: 'type', type: 'pie', title: 'Доли типов активов (Все время)' },
        { id: 2, source: 'trend', type: 'line', title: 'История изменения капитала' }
    ]
};

let activeChartsInstances = {};

// --- МОДУЛЬ АВТОРИЗАЦИИ (FIREBASE AUTH) ---
document.addEventListener('DOMContentLoaded', () => {
    initAuthListeners();
    initDOMListeners();
    initSwipeGestures();

    // Проверка сессии Firebase
    if (window.firebase) {
        firebase.auth().onAuthStateChanged(async (user) => {
            if (user) {
                state.userUid = user.uid;
                document.getElementById('auth-screen').classList.remove('active');
                loadLocalSettings();
                await syncWithFirebase();
                await fetchOnlineRates();
                renderAll();
            } else {
                state.userUid = null;
                document.getElementById('auth-screen').classList.add('active');
                updateStatus('Требуется вход');
            }
        });
    }
});

function initAuthListeners() {
    let isSignUpMode = false;
    const form = document.getElementById('auth-form');
    const toggleBtn = document.getElementById('toggle-auth-mode');
    const title = document.getElementById('auth-title');
    const submitBtn = document.getElementById('auth-submit-btn');
    const errorEl = document.getElementById('auth-error');

    toggleBtn.addEventListener('click', () => {
        isSignUpMode = !isSignUpMode;
        title.innerText = isSignUpMode ? "Регистрация профиля" : "Вход в систему";
        submitBtn.innerText = isSignUpMode ? "Создать аккаунт" : "Войти";
        toggleBtn.innerText = isSignUpMode ? "Войти в существующий" : "Зарегистрироваться";
        errorEl.innerText = "";
    });

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const email = document.getElementById('auth-email').value;
        const password = document.getElementById('auth-password').value;
        errorEl.innerText = "Обработка...";

        if (isSignUpMode) {
            firebase.auth().createUserWithEmailAndPassword(email, password)
                .catch(err => errorEl.innerText = "Ошибка регистрации: " + err.message);
        } else {
            firebase.auth().signInWithEmailAndPassword(email, password)
                .catch(err => errorEl.innerText = "Ошибка входа: " + err.message);
        }
    });

    document.getElementById('logout-btn').addEventListener('click', () => {
        if(confirm('Выйти из профиля?')) firebase.auth().signOut();
    });
}

// --- СИНХРОНИЗАЦИЯ Firestore (Под привязкой UID пользователя) ---
async function syncWithFirebase() {
    if (window.db && state.userUid) {
        updateStatus('Синхронизация...');
        try {
            const snapshot = await window.db.collection('finance_tracker_users').doc(state.userUid).get();
            if (snapshot.exists) {
                const cloud = snapshot.data();
                state.finances = cloud.finances || [];
                if(cloud.directories) state.directories = cloud.directories;
                if(cloud.customCharts) state.customCharts = cloud.customCharts;
            } else {
                await saveToFirebase();
            }
            updateStatus('☁️ Данные защищены');
        } catch (e) {
            updateStatus('⚠️ Локальная копия');
            console.error(e);
        }
    }
}

async function saveToFirebase() {
    if (window.db && state.userUid) {
        try {
            await window.db.collection('finance_tracker_users').doc(state.userUid).set({
                finances: state.finances,
                directories: state.directories,
                customCharts: state.customCharts
            });
        } catch (e) {
            console.error("Критическая ошибка прав записи Firestore:", e);
        }
    }
}

// --- РЕНДЕРИНГ И РАСЧЕТ ДИНАМИЧЕСКИХ ГРАФИКОВ И ТРЕНДОВ ---
function renderDashboardCharts() {
    const container = document.getElementById('charts-container');

    Object.keys(activeChartsInstances).forEach(id => {
        if(activeChartsInstances[id]) activeChartsInstances[id].destroy();
    });
    activeChartsInstances = {};
    container.innerHTML = "";

    state.customCharts.forEach(c => {
        // Fallback for period property if legacy charts exist
        const periodOption = c.period || 'ALL';

        const card = document.createElement('div');
        card.className = 'dashboard-chart-card';
        card.innerHTML = `
            <div class="chart-card-header">
                <h5>${c.title}</h5>
                <button class="btn-delete-chart" onclick="deleteCustomChart(${c.id})">×</button>
            </div>
            <div style="height: 230px; position: relative;">
                <canvas id="canvas-chart-${c.id}"></canvas>
            </div>
        `;
        container.appendChild(card);

        // Filter the dataset based on chart configuration rules
        let filteredFinances = filterDataByPeriod(state.finances, periodOption);

        let chartData = { labels: [], values: [] };
        if (c.source === 'trend') {
            chartData = calculateHistoricalTrend(filteredFinances);
        } else {
            chartData = calculateStructureDistribution(filteredFinances, c.source);
        }

        const ctx = document.getElementById(`canvas-chart-${c.id}`).getContext('2d');
        const themeColors = ['#2563eb', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];

        activeChartsInstances[c.id] = new Chart(ctx, {
            type: c.type,
            data: {
                labels: chartData.labels,
                datasets: [{
                    label: `В валюте ${state.directories.baseCurrency}`,
                    data: chartData.values,
                    backgroundColor: c.type === 'pie' ? themeColors : '#2563eb',
                    borderColor: c.type === 'line' ? '#2563eb' : 'transparent',
                    tension: 0.1,
                    fill: c.type !== 'line'
                }]
            },
            options: { responsive: true, maintainAspectRatio: false }
        });
    });
}

// Utility to slice data elements by current time offsets
function filterDataByPeriod(data, periodMonths) {
    if (periodMonths === 'ALL') return data;

    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - parseInt(periodMonths));

    return data.filter(item => {
        const itemDate = new Date(item.date);
        return itemDate >= cutoffDate;
    });
}

function calculateHistoricalTrend(dataset) {
    const monthlyData = {};

    dataset.forEach(item => {
        const d = new Date(item.date);
        if(isNaN(d)) return;
        const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const amtInBase = convertToBase(item.amount, item.currency);

        if (!monthlyData[monthKey]) monthlyData[monthKey] = {};
        const assetUniqueKey = `${item.type}_${item.org}_${item.currency}`;
        monthlyData[monthKey][assetUniqueKey] = { date: d, amount: amtInBase };
    });

    const labels = [];
    const values = [];

    Object.keys(monthlyData).sort().forEach(m => {
        labels.push(m);
        let totalMonthWealth = 0;
        Object.keys(monthlyData[m]).forEach(asset => {
            totalMonthWealth += monthlyData[m][asset].amount;
        });
        values.push(totalMonthWealth);
    });

    return { labels, values };
}

function calculateStructureDistribution(dataset, sourceField) {
    const totals = {};
    dataset.forEach(item => {
        const amt = convertToBase(item.amount, item.currency);
        totals[item[sourceField]] = (totals[item[sourceField]] || 0) + amt;
    });
    return { labels: Object.keys(totals), values: Object.values(totals) };
}

// Intercept interface inputs to capture specific chart window periods
document.getElementById('add-chart-btn').addEventListener('click', async () => {
    const src = document.getElementById('new-chart-source').value;
    const type = document.getElementById('new-chart-type').value;
    const period = document.getElementById('new-chart-period').value;

    const titles = {
        type: 'Доли типов активов',
        org: 'Распределение по организациям',
        trend: 'Исторический тренд капитала'
    };

    const periodLabels = {
        'ALL': 'все время',
        '3': '3 мес.',
        '6': '6 мес.',
        '12': '1 год'
    };

    const newChart = {
        id: Date.now(),
        source: src,
        type: type,
        period: period,
        title: `${titles[src]} (${periodLabels[period]})`
    };

    state.customCharts.push(newChart);
    await saveToFirebase();
    renderDashboardCharts();
});


window.deleteCustomChart = async function(id) {
    state.customCharts = state.customCharts.filter(c => c.id !== id);
    await saveToFirebase();
    renderDashboardCharts();
};

// --- ОСТАЛЬНАЯ ЧАСТЬ КОРНЕВОЙ ЛОГИКИ APP.JS ---
function loadLocalSettings() {
    const savedDirs = localStorage.getItem('fin_dirs');
    if (savedDirs) state.directories = JSON.parse(savedDirs);
    const savedRates = localStorage.getItem('fin_rates');
    if (savedRates) state.rates = JSON.parse(savedRates);
    const savedMode = localStorage.getItem('fin_rate_mode');
    if (savedMode) state.rateAutoMode = JSON.parse(savedMode);
}

async function fetchOnlineRates() {
    if (!state.rateAutoMode) return;
    try {
        const base = state.directories.baseCurrency;
        const res = await fetch(`https://er-api.com/v6/latest/${base}`);
        const data = await res.json();
        if (data && data.rates) {
            state.directories.currencies.forEach(cur => {
                if (cur === base) state.rates[cur] = 1;
                else if (data.rates[cur]) state.rates[cur] = parseFloat(((1 / data.rates[cur]) * 0.99).toFixed(4));
            });
            localStorage.setItem('fin_rates', JSON.stringify(state.rates));
        }
    } catch (e) { console.warn("Используются офлайн-курсы валют", e); }
}


function renderAll() {
  renderSelectOptions();
  renderDataTable();
  renderPivotReport();
  renderSettingsPanel();
  renderDashboardCharts();
}

function renderSelectOptions() {
  const renderSelect = (id, list) => {
      const select = document.getElementById(id); if(!select) return;
      const val = select.value;
      select.innerHTML = list.map(item => `<option value="${item}">${item}</option>`).join('');
      if (list.includes(val)) select.value = val;
  };
  renderSelect('f-type', state.directories.types);
  renderSelect('f-org', state.directories.orgs);
  renderSelect('f-currency', state.directories.currencies);
  renderSelect('set-base-currency', state.directories.currencies);

  const uniqueDates = [...new Set(state.finances.map(f => f.date))].sort();
  const dateSelect = document.getElementById('pivot-filter-date');
  dateSelect.innerHTML = '<option value="ALL">Все даты</option>' + uniqueDates.map(d => `<option value="${d}">${formatDate(d)}</option>`).join('');
  document.querySelectorAll('.base-currency-label').forEach(el => el.innerText = state.directories.baseCurrency);
}

function convertToBase(amount, fromCurrency) {
  const base = state.directories.baseCurrency;
  if (fromCurrency === base) return amount;
  return amount * (state.rates[fromCurrency] || 1);
}

function renderDataTable() {
  const tbody = document.getElementById('data-rows'); tbody.innerHTML = "";
  const sorted = [...state.finances].sort((a,b) => new Date(b.date) - new Date(a.date));
  sorted.forEach(item => {
      const origIndex = state.finances.indexOf(item);
      const inBase = convertToBase(item.amount, item.currency);
      const tr = document.createElement('tr');
      tr.innerHTML = `
          <td><b>${formatDate(item.date)}</b></td>
          <td>${item.type}</td>
          <td>${item.org}</td>
          <td>${item.amount.toLocaleString()}</td>
          <td><span class="status-badge">${item.currency}</span></td>
          <td><b>${inBase.toLocaleString(undefined, {maximumFractionDigits:2})}</b></td>
          <td class="text-center">
              <button class="btn btn-secondary" style="padding:4px 8px;" onclick="editRecord(${origIndex})">✏️</button>
              <button class="btn btn-danger" style="padding:4px 8px;" onclick="deleteRecord(${origIndex})">🗑️</button>
          </td>
      `;
      tbody.appendChild(tr);
  });
}

function renderPivotReport() {
  const row1 = document.getElementById('pivot-row-1').value;
  const row2 = document.getElementById('pivot-row-2').value;
  const date = document.getElementById('pivot-filter-date').value;
  let data = state.finances;

  if (date !== 'ALL') data = data.filter(d => d.date === date);

  const tree = {};
  data.forEach(item => {
      const val1 = row1 === 'date' ? formatDate(item.date) : item[row1];
      const val2 = row2 === 'none' ? null : (row2 === 'date' ? formatDate(item.date) : item[row2]);
      const amtBase = convertToBase(item.amount, item.currency);

      if (!tree[val1]) tree[val1] = { total: 0, sub: {} };
      tree[val1].total += amtBase;
      if (val2) {
          tree[val1].sub[val2] = (tree[val1].sub[val2] || 0) + amtBase;
      }
  });

  const tbody = document.getElementById('pivot-rows'); tbody.innerHTML = "";
  document.getElementById('pivot-headers').innerHTML = `<th>Группировка</th><th>Сумма (${state.directories.baseCurrency})</th>`;

  Object.keys(tree).sort().forEach(k1 => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><b>${k1}</b></td><td><b>${tree[k1].total.toLocaleString(undefined, {maximumFractionDigits:2})}</b></td>`;
      tbody.appendChild(tr);

      if (row2 !== 'none') {
          Object.keys(tree[k1].sub).sort().forEach(k2 => {
              const subTr = document.createElement('tr');
              subTr.className = 'sub-row';
              subTr.innerHTML = `<td>↳ ${k2}</td><td>${tree[k1].sub[k2].toLocaleString(undefined, {maximumFractionDigits:2})}</td>`;
              tbody.appendChild(subTr);
          });
      }
  });
}

function renderSettingsPanel() {
    // 1. Селектор базовой валюты
    const baseSelect = document.getElementById('set-base-currency');
    baseSelect.innerHTML = state.directories.currencies.map(cur =>
        `<option value="${cur}" ${cur === state.directories.baseCurrency ? 'selected' : ''}>${currencyDictionary[cur] || cur}</option>`
    ).join('');

    // 2. Список валют для добавления (исключая уже добавленные)
    const newCurSelect = document.getElementById('new-currency-select');
    newCurSelect.innerHTML = Object.keys(currencyDictionary)
        .filter(code => !state.directories.currencies.includes(code))
        .map(code => `<option value="${code}">${currencyDictionary[code]}</option>`).join('');

    // 3. Отрисовка списков по одному элементу
    const renderList = (elementId, items, isCurrency = false) => {
        const ul = document.getElementById(elementId);
        ul.innerHTML = items.map((item, idx) => `
            <li>
                <span>${isCurrency ? (currencyDictionary[item] || item) : item}</span>
                ${item === state.directories.baseCurrency ? '<small style="color:var(--success);">базовая</small>' : `
                    <button class="btn-delete-item" onclick="deleteDirectoryItem('\({elementId}',\){idx})">❌</button>
                `}
            </li>
        `).join('');
    };

    renderList('list-currencies', state.directories.currencies, true);
    renderList('list-types', state.directories.types);
    renderList('list-orgs', state.directories.orgs);

    // 4. Отрисовка полей курсов валют
    const manualContainer = document.getElementById('manual-rates-container');
    manualContainer.innerHTML = '<h4>Курсы валют (в базовой):</h4>';
    document.getElementById('save-rates-btn').style.display = state.rateAutoMode ? 'none' : 'block';
    document.getElementById('rate-auto-mode').checked = state.rateAutoMode;

    state.directories.currencies.forEach(cur => {
        if (cur === state.directories.baseCurrency) return;
        const div = document.createElement('div'); div.className = 'form-group';
        div.innerHTML = `<label>${cur}:</label><input type="number" step="any" class="manual-rate-input" data-cur="${cur}" value="${state.rates[cur] || 0}" ${state.rateAutoMode ? 'disabled' : ''}>`;
        manualContainer.appendChild(div);
    });
}


function initDOMListeners() {
  document.getElementById('asset-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const index = document.getElementById('edit-index').value;
      const record = {
          date: document.getElementById('f-date').value,
          type: document.getElementById('f-type').value,
          org: document.getElementById('f-org').value,
          amount: parseFloat(document.getElementById('f-amount').value),
          currency: document.getElementById('f-currency').value
      };
      if (index === "") state.finances.push(record);
      else state.finances[index] = record;
      await saveToFirebase(); resetForm(); renderAll();
  });

  document.getElementById('clear-form-btn').addEventListener('click', resetForm);
  document.getElementById('copy-slice-btn').addEventListener('click', async () => {
      if (!state.finances.length) return alert('Нет данных.');
      const maxDate = new Date(Math.max(...state.finances.map(f => new Date(f.date)))).toISOString().split('T');
      const lastSlice = state.finances.filter(f => f.date === maxDate);
      const today = new Date().toISOString().split('T');
      lastSlice.forEach(item => state.finances.push({ ...item, date: today }));
      await saveToFirebase(); renderAll(); alert(`Срез скопирован.`);
  });

  document.getElementById('export-csv-btn').addEventListener('click', exportToCSV);
  document.getElementById('pivot-row-1').addEventListener('change', renderPivotReport);
  document.getElementById('pivot-row-2').addEventListener('change', renderPivotReport);
  document.getElementById('pivot-filter-date').addEventListener('change', renderPivotReport);

  // document.getElementById('save-directories-btn').addEventListener('click', async () => {
  //     state.directories.baseCurrency = document.getElementById('set-base-currency').value;
  //     state.directories.types = document.getElementById('set-types').value.split(',').map(s => s.trim()).filter(Boolean);
  //     state.directories.orgs = document.getElementById('set-orgs').value.split(',').map(s => s.trim()).filter(Boolean);
  //     localStorage.setItem('fin_dirs', JSON.stringify(state.directories));
  //     await fetchOnlineRates(); await saveToFirebase(); renderAll();
  // });

  document.getElementById('rate-auto-mode').addEventListener('change', async (e) => {
      state.rateAutoMode = e.target.checked;
      localStorage.setItem('fin_rate_mode', JSON.stringify(state.rateAutoMode));
      if(state.rateAutoMode) await fetchOnlineRates();
      renderAll();
  });

  document.getElementById('save-rates-btn').addEventListener('click', () => {
      document.querySelectorAll('.manual-rate-input').forEach(input => {
          state.rates[input.getAttribute('data-cur')] = parseFloat(input.value) || 1;
      });
      localStorage.setItem('fin_rates', JSON.stringify(state.rates));
      renderAll();
  });

  document.querySelectorAll('.tab-btn').forEach((btn, idx) => {
      btn.addEventListener('click', () => activeTabByIndex(idx));
  });

  // Добавление Валюты по одной
  document.getElementById('add-currency-btn').addEventListener('click', async () => {
      const select = document.getElementById('new-currency-select');
      if (select.value && !state.directories.currencies.includes(select.value)) {
          state.directories.currencies.push(select.value);
          localStorage.setItem('fin_dirs', JSON.stringify(state.directories));
          await fetchOnlineRates();
          await saveToFirebase();
          renderAll();
      }
  });

  // Добавление Типа актива по одному
  document.getElementById('add-type-btn').addEventListener('click', async () => {
      const input = document.getElementById('new-type-input');
      const val = input.value.trim();
      if (val && !state.directories.types.includes(val)) {
          state.directories.types.push(val);
          input.value = '';
          localStorage.setItem('fin_dirs', JSON.stringify(state.directories));
          await saveToFirebase();
          renderAll();
      }
  });

  // Добавление Организации по одной
  document.getElementById('add-org-btn').addEventListener('click', async () => {
      const input = document.getElementById('new-org-input');
      const val = input.value.trim();
      if (val && !state.directories.orgs.includes(val)) {
          state.directories.orgs.push(val);
          input.value = '';
          localStorage.setItem('fin_dirs', JSON.stringify(state.directories));
          await saveToFirebase();
          renderAll();
      }
  });

}

const tabIds = ['data-tab', 'pivot-tab', 'settings-tab'];
let activeTabIdx = 0;
function activeTabByIndex(index) {
  if(index < 0 || index >= tabIds.length) return;
  activeTabIdx = index;
  document.querySelectorAll('.tab-btn').forEach((btn, idx) => btn.classList.toggle('active', idx === index));
  document.querySelectorAll('.tab-content').forEach((content, idx) => content.classList.toggle('active', idx === index));
  // document.getElementById('swipe-container').style.transform = `translateX(-${index * 33.333}%)`;
  if (tabIds[index] === 'pivot-tab') { renderPivotReport(); renderDashboardCharts(); }
}

function initSwipeGestures() {
  const container = document.getElementById('swipe-container');
  let startX = 0;
  container.addEventListener('touchstart', (e) => startX = e.changedTouches.pageX, false);
  container.addEventListener('touchend', (e) => {
      let diff = startX - e.changedTouches.pageX;
      if (Math.abs(diff) > 70) {
          if (diff > 0) activeTabByIndex(activeTabIdx + 1);
          else activeTabByIndex(activeTabIdx - 1);
      }
  }, false);
}

function resetForm() {
  document.getElementById('asset-form').reset(); document.getElementById('edit-index').value = "";
  document.getElementById('f-date').value = new Date().toISOString().split('T'); document.getElementById('submit-btn').innerText = "Сохранить";
}

window.editRecord = function(index) {
  const item = state.finances[index];
  document.getElementById('edit-index').value = index; document.getElementById('f-date').value = item.date;
  document.getElementById('f-type').value = item.type; document.getElementById('f-org').value = item.org;
  document.getElementById('f-amount').value = item.amount; document.getElementById('f-currency').value = item.currency;
  document.getElementById('submit-btn').innerText = "Обновить"; activeTabByIndex(0);
};

window.deleteRecord = async function(index) {
  if (confirm('Удалить запись?')) { state.finances.splice(index, 1); await saveToFirebase(); renderAll(); }
};

function formatDate(dateStr) { return new Date(dateStr).toLocaleDateString('ru-RU', { year: 'numeric', month: '2-digit', day: '2-digit' }); }

function exportToCSV() {
  let csvContent = "\uFEFFДата,Тип актива,Организация,Сумма,Валюта\n";
  state.finances.forEach(item => csvContent += `${item.date},${item.type},${item.org},${item.amount},${item.currency}\n`);
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob);
  link.setAttribute("download", `export_${new Date().toISOString().split('T')[0]}.csv`);
  document.body.appendChild(link); link.click(); document.body.removeChild(link);
}


// Удаление элемента из списка справочника
window.deleteDirectoryItem = async function(listId, index) {
    if (!confirm('Вы уверены, что хотите удалить этот элемент из списков настроек?')) return;

    if (listId === 'list-currencies') {
        const cur = state.directories.currencies[index];
        if (cur === state.directories.baseCurrency) return alert('Нельзя удалить базовую валюту!');
        state.directories.currencies.splice(index, 1);
        delete state.rates[cur];
    } else if (listId === 'list-types') {
        state.directories.types.splice(index, 1);
    } else if (listId === 'list-orgs') {
        state.directories.orgs.splice(index, 1);
    }

    localStorage.setItem('fin_dirs', JSON.stringify(state.directories));
    await saveToFirebase();
    renderAll();
};

// Смена базовой валюты приложения
window.changeBaseCurrency = async function(newBase) {
    state.directories.baseCurrency = newBase;
    localStorage.setItem('fin_dirs', JSON.stringify(state.directories));
    updateStatus('Пересчет курсов...');
    await fetchOnlineRates();
    await saveToFirebase();
    renderAll();
};
