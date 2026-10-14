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
        // Изменено: теперь по умолчанию стоит LAST_SLICE
        { id: 1, source: 'type', type: 'pie', period: 'LAST_SLICE', title: 'Доли типов активов (Последний срез)' },
        { id: 2, source: 'trend', type: 'line', period: 'ALL', title: 'История изменения капитала' }
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
// --- ИСПРАВЛЕННЫЙ РЕНДЕРИНГ ДИНАМИЧЕСКИХ ГРАФИКОВ ДАШБОРДА ---
// --- ИСПРАВЛЕННЫЙ И РАСШИРЕННЫЙ СТРУКТУРНЫЙ БЛОК STATE ---
// Добавим в состояние по умолчанию конфигурацию размеров для Сводной таблицы и графиков
state.widgetLayouts = state.widgetLayouts || {
    "pivot-table-widget": { cols: 12, height: 300, order: 0 }
};

// --- ГЛАВНЫЙ ДВИЖОК ГЕНЕРАЦИИ И УПРАВЛЕНИЯ СЕТКОЙ ДАШБОРДА ---
function renderDashboardCharts() {
    const gridContainer = document.getElementById('dashboard-grid-container');
    if (!gridContainer) return;

    // Сначала уничтожаем все старые инстансы графиков Chart.js
    Object.keys(activeChartsInstances).forEach(id => {
        if(activeChartsInstances[id]) activeChartsInstances[id].destroy();
    });
    activeChartsInstances = {};
    gridContainer.innerHTML = "";

    // 1. СОЗДАЕМ И СОРТИРУЕМ ВСЕ ВИДЖЕТЫ (Таблицу + Кастомные графики)
    let allWidgets = [
        { id: "pivot-table-widget", type: "pivot", title: `Сводная таблица (Единый баланс)`, period: 'ALL' },
        ...state.customCharts.map(c => ({ ...c, type: "chart" }))
    ];

    // Сортировка виджетов согласно их сохраненному порядку в базе данных
    allWidgets.sort((a, b) => {
        const orderA = state.widgetLayouts[a.id]?.order || 0;
        const orderB = state.widgetLayouts[b.id]?.order || 0;
        return orderA - orderB;
    });

    // 2. ОТРИСОВКА КАЖДОГО ВИДЖЕТА В СЕТКУ
    allWidgets.forEach((w, index) => {
        // Подгружаем сохраненную конфигурацию сетки или ставим базовые размеры
        const layout = state.widgetLayouts[w.id] || { cols: w.type === 'pivot' ? 12 : 6, height: 320, order: index };
        state.widgetLayouts[w.id] = layout; // Гарантируем запись в state

        const card = document.createElement('div');
        card.className = 'dashboard-widget-card';
        card.style.gridColumn = `span ${layout.cols}`;
        card.style.height = `${layout.height}px`;

        card.innerHTML = `
            <div class="widget-header">
                <div class="widget-title">${w.title}</div>
                <div class="widget-controls">
                    <button class="btn-widget-action" onclick="resizeWidget('${w.id}', -1)" title="Сузить">◀</button>
                    <button class="btn-widget-action" onclick="resizeWidget('${w.id}', 1)" title="Расширить">▶</button>
                    <button class="btn-widget-action" onclick="resizeHeightWidget('${w.id}', -40)" title="Уменьшить высоту">▲</button>
                    <button class="btn-widget-action" onclick="resizeHeightWidget('${w.id}', 40)" title="Увеличить высоту">▼</button>
                    <button class="btn-widget-action" onclick="moveWidgetOrder('${w.id}', -1)" title="Сдвинуть влево/вверх">⬅</button>
                    <button class="btn-widget-action" onclick="moveWidgetOrder('${w.id}', 1)" title="Сдвинуть вправо/вниз">➡</button>
                    ${w.type === 'chart' ? `<button class="btn-widget-action delete" onclick="deleteCustomChart(${w.id})" title="Удалить график">×</button>` : ''}
                </div>
            </div>
            <div class="widget-body" id="body-widget-${w.id}">
                <!-- Контент рендерится ниже в зависимости от типа виджета -->
            </div>
        `;
        gridContainer.appendChild(card);

        // 3. НАПОЛНЕНИЕ ТЕЛО ВИДЖЕТА ДАННЫМИ
        if (w.type === "pivot") {
            // Отрендерить сводную таблицу внутрь текущего виджета сетки
            injectPivotTableHTML(`body-widget-${w.id}`);
        } else {
            // Отрендерить график Chart.js внутрь виджета сетки
            injectChartCanvas(w, `body-widget-${w.id}`);
        }
    });
}

// Вспомогательная функция инъекции сводной таблицы в сетку
// Вспомогательная функция инъекции сводной таблицы в сетку
// Вспомогательная функция инъекции сводной таблицы в сетку дашборда
function injectPivotTableHTML(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.style.overflowY = "auto";

    // 1. Создаем каркас таблицы в памяти
    container.innerHTML = `
        <div class="table-wrapper" style="border:none;">
            <table>
                <thead>
                    <tr id="pivot-headers"></tr>
                </thead>
                <tbody id="pivot-rows"></tbody>
            </table>
        </div>
    `;

    // 2. ИСПРАВЛЕНО: Убираем setTimeout и вызываем наполнение строками СИНХРОННО!
    // Теперь данные рендерятся мгновенно, без задержек и сбоев отрисовки браузера.
    renderPivotReportRowsOnly();
}


// Функция сборки строк Сводной Таблицы
// Функция сборки строк Сводной Таблицы
function renderPivotReportRowsOnly() {
    const tbody = document.getElementById('pivot-rows');
    const headers = document.getElementById('pivot-headers');

    // Безопасный барьер
    if (!tbody || !headers) return;

    const row1 = document.getElementById('pivot-row-1').value;
    const row2 = document.getElementById('pivot-row-2').value;
    const dateFilter = document.getElementById('pivot-filter-date').value;
    let data = state.finances;

    if (!data || !data.length) {
        tbody.innerHTML = `<tr><td colspan="3" class="text-center">Нет данных для анализа</td></tr>`;
        return;
    }

    if (dateFilter === 'ALL') {
        const maxDateStr = data.reduce((max, item) => new Date(item.date) > new Date(max) ? item.date : max, data[0].date);
        data = data.filter(d => d.date === maxDateStr);
    } else {
        data = data.filter(d => d.date === dateFilter);
    }

    let grandTotalBase = data.reduce((sum, item) => sum + convertToBase(item.amount, item.currency), 0);
    const tree = {};
    data.forEach(item => {
        const val1 = row1 === 'date' ? formatDate(item.date) : item[row1];
        const val2 = row2 === 'none' ? null : (row2 === 'date' ? formatDate(item.date) : item[row2]);
        const amtBase = convertToBase(item.amount, item.currency);
        if (!tree[val1]) tree[val1] = { total: 0, sub: {} };
        tree[val1].total += amtBase;
        if (val2) tree[val1].sub[val2] = (tree[val1].sub[val2] || 0) + amtBase;
    });

    // Собираем весь HTML-код строк в одну переменную, чтобы выдать браузеру за один раз
    let rowsHtml = "";
    const activeDateLabel = dateFilter === 'ALL' && data.length > 0 ? formatDate(data[0].date) : formatDate(dateFilter);
    headers.innerHTML = `<th>Группировка (${activeDateLabel})</th><th>Сумма (${state.directories.baseCurrency})</th><th>Доля (%)</th>`;

    Object.keys(tree).sort().forEach(k1 => {
        const share1 = grandTotalBase > 0 ? ((tree[k1].total / grandTotalBase) * 100).toFixed(1) : 0;
        rowsHtml += `<tr><td><b>${k1}</b></td><td><b>${tree[k1].total.toLocaleString(undefined,{maximumFractionDigits:2})}</b></td><td><span class="status-badge" style="background:var(--primary-light); color:var(--primary); font-weight:600;">${share1}%</span></td></tr>`;

        if (row2 !== 'none') {
            Object.keys(tree[k1].sub).sort().forEach(k2 => {
                const share2 = grandTotalBase > 0 ? ((tree[k1].sub[k2] / grandTotalBase) * 100).toFixed(1) : 0;
                rowsHtml += `<tr class="sub-row"><td>↳ ${k2}</td><td>${tree[k1].sub[k2].toLocaleString(undefined,{maximumFractionDigits:2})}</td><td style="color:var(--text-muted); font-size:12px;">${share2}%</td></tr>`;
            });
        }
    });

    tbody.innerHTML = rowsHtml || `<tr><td colspan="3" class="text-center">Нет данных</td></tr>`;
}



// Заглушка вызова перерисовки строк таблицы при обновлении селекторов
function renderPivotReport() {
    renderDashboardCharts();
}

// Инъекция графиков Chart.js в тело виджета сетки
// Инъекция графиков Chart.js в тело виджета сетки
function injectChartCanvas(c, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = `<canvas id="canvas-chart-${c.id}"></canvas>`;

    let chartPeriod = c.period || 'LAST_SLICE';
    if ((c.source === 'type' || c.source === 'org') && chartPeriod === 'ALL') {
        chartPeriod = 'LAST_SLICE';
    }

    let filteredFinances = filterDataByPeriod(state.finances, chartPeriod);
    let chartData = c.source === 'trend' ? calculateHistoricalTrend(filteredFinances) : calculateStructureDistribution(filteredFinances, c.source);

    const ctx = document.getElementById(`canvas-chart-${c.id}`).getContext('2d');
    const themeColors = ['#2563eb', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];

    // ИСПРАВЛЕНО: Берем оригинальный тип графика из структуры базы данных
    // В первом коде он записывался в поле c.type, но из-за наложения структур ALL_WIDGETS
    // техническое поле перезаписывало его строкой "chart".
    // Мы делаем безопасный фолбек: если тип равен техническому "chart", берем сохраненное свойство из конфигурации.
    const realChartType = (c.type === 'chart' && state.customCharts.find(item => item.id === c.id)?.type) || c.type;

    activeChartsInstances[c.id] = new Chart(ctx, {
        type: realChartType, // ИСПОЛЬЗУЕМ КОРРЕКТНЫЙ ТИП (bar, pie или line)
        data: {
            labels: chartData.labels,
            datasets: [{
                label: `В валюте ${state.directories.baseCurrency}`,
                data: chartData.values,
                backgroundColor: realChartType === 'pie' ? themeColors : '#2563eb',
                borderColor: realChartType === 'line' ? '#2563eb' : 'transparent',
                tension: 0.1,
                fill: realChartType !== 'line'
            }]
        },
        plugins: [ChartDataLabels],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                tooltip: { callbacks: { label: context => `${context.label}: ${context.raw.toLocaleString()}` } },
                datalabels: {
                    color: context => context.chart.config.type === 'pie' ? '#fff' : '#1e293b',
                    anchor: context => context.chart.config.type === 'pie' ? 'center' : 'end',
                    align: context => context.chart.config.type === 'pie' ? 'center' : 'top',
                    offset: 4,
                    font: { weight: 'bold', size: 11 },
                    formatter: function(value, context) {
                        // ИСПРАВЛЕНО: Добавлена жесткая защита от пустых массивов
                        const dataset = context.chart.data.datasets[0]?.data;
                        if (!dataset || !dataset.length) return '';

                        // Считаем общую сумму только если в массиве есть элементы
                        const totalSum = dataset.reduce((sum, val) => sum + (Number(val) || 0), 0);

                        if (totalSum > 0 && context.chart.config.type !== 'line') {
                            const percentage = ((value / totalSum) * 100).toFixed(1);
                            return percentage > 4 ? `${percentage}%` : '';
                        }
                        if (context.chart.config.type === 'line') return value >= 1000 ? (value / 1000).toFixed(0) + 'k' : value;
                        return '';
                    }
                }

            },
            scales: realChartType !== 'pie' ? { y: { beginAtZero: true, grace: '15%' } } : {}
        }
    });
}


// --- УПРАВЛЕНИЕ ГЕОМЕТРИЕЙ СЕТКИ (ИЗМЕНЕНИЕ РАЗМЕРОВ И ПОРЯДКА) ---
window.resizeWidget = async function(id, direction) {
    let currentCols = state.widgetLayouts[id]?.cols || 6;
    currentCols += direction;
    // Границы сетки: минимальная ширина — 3 колонки, максимальная — 12 колонок
    if (currentCols < 3) currentCols = 3;
    if (currentCols > 12) currentCols = 12;

    state.widgetLayouts[id].cols = currentCols;
    await saveLayoutConfig();
};

window.resizeHeightWidget = async function(id, pixelsDiff) {
    let currentHeight = state.widgetLayouts[id]?.height || 320;
    currentHeight += pixelsDiff;
    if (currentHeight < 200) currentHeight = 200;
    if (currentHeight > 800) currentHeight = 800;

    state.widgetLayouts[id].height = currentHeight;
    await saveLayoutConfig();
};

window.moveWidgetOrder = async function(id, direction) {
    let allWidgets = ["pivot-table-widget", ...state.customCharts.map(c => String(c.id))];
    allWidgets.sort((a, b) => (state.widgetLayouts[a]?.order || 0) - (state.widgetLayouts[b]?.order || 0));

    const currentIndex = allWidgets.indexOf(id);
    const targetIndex = currentIndex + direction;

    if (targetIndex >= 0 && targetIndex < allWidgets.length) {
        // Меняем порядок элементов местами в массиве сортировки
        const temp = allWidgets[currentIndex];
        allWidgets[currentIndex] = allWidgets[targetIndex];
        allWidgets[targetIndex] = temp;

        // Переписываем индексы order для всех элементов дашборда
        allWidgets.forEach((wId, idx) => {
            if (!state.widgetLayouts[wId]) state.widgetLayouts[wId] = { cols: 6, height: 320 };
            state.widgetLayouts[wId].order = idx;
        });

        await saveLayoutConfig();
    }
};

// Функция записи конфигурации плиток в память и Firestore БД
async function saveLayoutConfig() {
    localStorage.setItem('fin_widget_layouts', JSON.stringify(state.widgetLayouts));

    // Интеграция сохранения в Firestore
    if (window.db && state.userUid) {
        try {
            await window.db.collection('finance_tracker_users').doc(state.userUid).update({
                widgetLayouts: state.widgetLayouts
            });
            updateStatus('☁️ Сетка сохранена');
        } catch (e) {
            // Если документ еще не содержит поля update, пишем через set с merge
            await window.db.collection('finance_tracker_users').doc(state.userUid).set({
                widgetLayouts: state.widgetLayouts
            }, { merge: true });
        }
    }
    // Быстрая живая перерисовка сетки без перезагрузки всей страницы
    renderDashboardCharts();
}

// --- УПРАВЛЕНИЕ ТАБАМИ И СВАЙПАМИ ---
const tabIds = ['data-tab', 'pivot-tab', 'settings-tab'];
let activeTabIdx = 0;

function activeTabByIndex(index) {
    if(index < 0 || index >= tabIds.length) return;
    activeTabIdx = index;
    document.querySelectorAll('.tab-btn').forEach((btn, idx) => btn.classList.toggle('active', idx === index));
    document.querySelectorAll('.tab-content').forEach((content, idx) => content.classList.toggle('active', idx === index));
    document.getElementById('swipe-container').style.transform = `translateX(-${index * 33.333}%)`;
    if (tabIds[index] === 'pivot-tab') {
        renderDashboardCharts();
    }
}

function initSwipeGestures() {
    const container = document.getElementById('swipe-container');
    let startX = 0;
    let startY = 0;
    let shouldBlockSwipe = false;

    container.addEventListener('touchstart', (e) => {
        startX = e.changedTouches.pageX;
        startY = e.changedTouches.pageY;
        const isTargetInsideTable = e.target.closest('.table-wrapper');
        shouldBlockSwipe = !!isTargetInsideTable;
    }, { passive: true });

    container.addEventListener('touchend', (e) => {
        if (shouldBlockSwipe) return;

        let diffX = startX - e.changedTouches.pageX;
        let diffY = startY - e.changedTouches.pageY;

        if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 80) {
            if (diffX > 0) activeTabByIndex(activeTabIdx + 1);
            else activeTabByIndex(activeTabIdx - 1);
        }
    }, { passive: true });
}

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ И ЭКСПОРТ ---
function resetForm() {
    document.getElementById('asset-form').reset();
    document.getElementById('edit-index').value = "";
    document.getElementById('f-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('submit-btn').innerText = "Сохранить";
}

window.editRecord = function(index) {
    const item = state.finances[index];
    document.getElementById('edit-index').value = index;
    document.getElementById('f-date').value = item.date;
    document.getElementById('f-type').value = item.type;
    document.getElementById('f-org').value = item.org;
    document.getElementById('f-amount').value = item.amount;
    document.getElementById('f-currency').value = item.currency;
    document.getElementById('submit-btn').innerText = "Обновить";
    activeTabByIndex(0);
};

window.deleteRecord = async function(index) {
    if (confirm('Удалить запись?')) {
        state.finances.splice(index, 1);
        await saveToFirebase();
        renderAll();
    }
};

function formatDate(dateStr) {
    return new Date(dateStr).toLocaleDateString('ru-RU', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function exportToCSV() {
    let csvContent = "\uFEFFДата,Тип актива,Организация,Сумма,Валюта\n";
    state.finances.forEach(item => csvContent += `${item.date},${item.type},${item.org},${item.amount},${item.currency}\n`);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.setAttribute("download", `export_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// --- ЛОГИКА РАБОТЫ СВОРАЧИВАЕМЫХ БЛОКОВ (ACCORDIONS) ---
window.toggleAccordion = function(accordionId) {
    const content = document.getElementById(accordionId);
    const arrow = document.getElementById(`arrow-${accordionId}`);

    if (!content || !arrow) return;
    const isCurrentlyOpen = content.classList.contains('open');

    document.querySelectorAll('.accordion-content').forEach(el => el.classList.remove('open'));
    document.querySelectorAll('.acc-arrow').forEach(el => el.classList.remove('rotated'));

    if (!isCurrentlyOpen) {
        content.classList.add('open');
        arrow.classList.add('rotated');
    }
};

window.closeAllAnalyticsAccordions = function() {
    document.querySelectorAll('.accordion-content').forEach(el => el.classList.remove('open'));
    document.querySelectorAll('.acc-arrow').forEach(el => el.classList.remove('rotated'));
};

document.addEventListener('DOMContentLoaded', () => {
    document.body.addEventListener('touchstart', (e) => {
        const openContent = document.querySelector('.accordion-content.open');
        if (!openContent) return;
        if (e.target.closest('.analytics-controls')) return;
        window.closeAllAnalyticsAccordions();
    }, { passive: true });

    const controlsPanel = document.querySelector('.analytics-controls');
    if (controlsPanel) {
        controlsPanel.addEventListener('mouseleave', () => {
            window.closeAllAnalyticsAccordions();
        });
    }
});



// Utility to slice data elements by current time offsets
// Расширенная утилита фильтрации данных для графиков
function filterDataByPeriod(data, periodOption) {
    if (!data.length) return data;

    // Опция 1: Изолируем только самый последний срез (максимальная дата в базе)
    if (periodOption === 'LAST_SLICE') {
        const maxDateStr = data.reduce((max, item) =>
            new Date(item.date) > new Date(max) ? item.date : max, data[0].date
        );
        return data.filter(item => item.date === maxDateStr);
    }

    // Опция 2: Фильтр по конкретной выбранной дате среза из конструктора
    if (periodOption.startsWith('DATE:')) {
        const targetDate = periodOption.split('DATE:')[1];
        return data.filter(item => item.date === targetDate);
    }

    // Опция 3: За все время
    if (periodOption === 'ALL') return data;

    // Опция 4: Относительные скользящие периоды (3, 6, 12 месяцев)
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - parseInt(periodOption));

    return data.filter(item => {
        const itemDate = new Date(item.date);
        return itemDate >= cutoffDate;
    });
}


// Вычисление тренда капитала (Теперь группирует строго по конкретным датам срезов)
function calculateHistoricalTrend(dataset) {
    const dailyData = {};

    dataset.forEach(item => {
        const dateKey = item.date; // Используем точную дату "ГГГГ-ММ-ДД" вместо месяца
        const amtInBase = convertToBase(item.amount, item.currency);

        if (!dailyData[dateKey]) {
            dailyData[dateKey] = 0;
        }
        // Суммируем все активы, которые были зафиксированы на эту конкретную дату
        dailyData[dateKey] += amtInBase;
    });

    const labels = [];
    const values = [];

    // Сортируем даты по хронологии (от старых к новым), чтобы график шел слева направо
    Object.keys(dailyData).sort().forEach(dateStr => {
        labels.push(formatDate(dateStr)); // Превращаем "2026-10-14" в красивый формат "14.10.2026"
        values.push(dailyData[dateStr]);
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
    let period = document.getElementById('new-chart-period').value;

    // УМНАЯ КОРРЕКЦИЯ: Если пользователь анализирует Исторический тренд капитала,
    // ему обязательно нужна вся история ('ALL'), а не одна точка последнего среза.
    if (src === 'trend' && period === 'LAST_SLICE') {
        period = 'ALL';
    }

    const titles = {
        type: 'Доли типов активов',
        org: 'Распределение по организациям',
        trend: 'Исторический тренд капитала'
    };

    let periodLabel = 'последний срез';
    if (period === 'ALL') periodLabel = 'все время';
    else if (period === '3') periodLabel = '3 мес.';
    else if (period === '6') periodLabel = '6 мес.';
    else if (period === '12') periodLabel = '1 год';
    else if (period.startsWith('DATE:')) {
        const rawDate = period.split('DATE:')[1];
        periodLabel = formatDate(rawDate);
    }

    const newChart = {
        id: Date.now(),
        source: src,
        type: type,
        period: period,
        title: `${titles[src]} (${periodLabel})`
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
        // Переключаемся на стабильный эндпоинт v6 с поддержкой CORS для веб-приложений
        const res = await fetch(`https://open.er-api.com/v6/latest/${base}`);
        const data = await res.json();

        if (data && data.rates) {
            state.directories.currencies.forEach(cur => {
                if (cur === base) state.rates[cur] = 1;
                else if (data.rates[cur]) {
                  // Конвертируем обратный курс API и закладываем вашу комиссию -1%
                    const directRate = 1 / data.rates[cur];
                    state.rates[cur] = parseFloat((directRate * 0.99).toFixed(4));
                }
            });
            localStorage.setItem('fin_rates', JSON.stringify(state.rates));
            updateStatus('☁️ Данные защищены');
        }
    } catch (e) {
      console.warn("Используются офлайн-курсы валют", e);
      updateStatus('⚠️ Офлайн-курсы');
    }
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

  // Обновляем селектор периодов и дат для создания нового графика
  const chartPeriodSelect = document.getElementById('new-chart-period');
  if (chartPeriodSelect) {
      // Сохраняем выбранное пользователем значение, чтобы оно не сбрасывалось при рендере
      const currentSelected = chartPeriodSelect.value;

      // Базовые системные опции
      let optionsHtml = `
          <option value="LAST_SLICE">Только последний срез (актуально)</option>
          <option value="ALL">За все время (история)</option>
          <option value="3">Последние 3 месяца</option>
          <option value="6">Последние 6 месяцев</option>
          <option value="12">Последний 1 год</option>
      `;

      // Добавляем к ним персональные даты срезов из вашей базы данных
      uniqueDates.sort((a, b) => new Date(b) - new Date(a)).forEach(d => {
          optionsHtml += `<option value="DATE:${d}">Срез на дату: ${formatDate(d)}</option>`;
      });

      chartPeriodSelect.innerHTML = optionsHtml;
      chartPeriodSelect.value = currentSelected || 'LAST_SLICE';
  }

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

// function renderPivotReport() {
//     const row1 = document.getElementById('pivot-row-1').value;
//     const row2 = document.getElementById('pivot-row-2').value;
//     const dateFilter = document.getElementById('pivot-filter-date').value;
//     let data = state.finances;
//
//     if (!data.length) {
//         const tbody = document.getElementById('pivot-rows');
//         if (tbody) tbody.innerHTML = `<tr><td colspan="3" class="text-center">Нет данных для анализа</td></tr>`;
//         return;
//     }
//
//     // ИСПРАВЛЕНО: Если выбрано "Все даты", автоматически фильтруем только по самому последнему срезу
//     if (dateFilter === 'ALL') {
//         const maxDateStr = data.reduce((max, item) =>
//             new Date(item.date) > new Date(max) ? item.date : max, data[0].date
//         );
//         data = data.filter(d => d.date === maxDateStr);
//     } else {
//         // Если выбрана конкретная дата — фильтруем строго по ней
//         data = data.filter(d => d.date === dateFilter);
//     }
//
//     // 1. Считаем Итоговую сумму капитала для этого конкретного среза
//     let grandTotalBase = 0;
//     data.forEach(item => {
//         grandTotalBase += convertToBase(item.amount, item.currency);
//     });
//
//     // 2. Строим дерево группировки
//     const tree = {};
//     data.forEach(item => {
//         const val1 = row1 === 'date' ? formatDate(item.date) : item[row1];
//         const val2 = row2 === 'none' ? null : (row2 === 'date' ? formatDate(item.date) : item[row2]);
//         const amtBase = convertToBase(item.amount, item.currency);
//
//         if (!tree[val1]) tree[val1] = { total: 0, sub: {} };
//         tree[val1].total += amtBase;
//         if (val2) {
//             tree[val1].sub[val2] = (tree[val1].sub[val2] || 0) + amtBase;
//         }
//     });
//
//     // 3. Выводим данные в таблицу
//     const tbody = document.getElementById('pivot-rows');
//     if (tbody) tbody.innerHTML = "";
//
//     // Обновляем заголовок, чтобы пользователь видел, за какую дату считается срез
//     const activeDateLabel = dateFilter === 'ALL' && data.length > 0 ? formatDate(data[0].date) : formatDate(dateFilter);
//     document.getElementById('pivot-headers').innerHTML = `<th>Группировка (Срез: ${activeDateLabel})</th><th>Сумма (${state.directories.baseCurrency})</th><th>Доля (%)</th>`;
//
//     Object.keys(tree).sort().forEach(k1 => {
//         const share1 = grandTotalBase > 0 ? ((tree[k1].total / grandTotalBase) * 100).toFixed(1) : 0;
//
//         const tr = document.createElement('tr');
//         tr.innerHTML = `
//             <td><b>${k1}</b></td>
//             <td><b>${tree[k1].total.toLocaleString(undefined, {maximumFractionDigits:2})}</b></td>
//             <td><span class="status-badge" style="background:var(--primary-light); color:var(--primary); font-weight:600;">${share1}%</span></td>
//         `;
//         tbody.appendChild(tr);
//
//         if (row2 !== 'none') {
//             Object.keys(tree[k1].sub).sort().forEach(k2 => {
//                 const share2 = grandTotalBase > 0 ? ((tree[k1].sub[k2] / grandTotalBase) * 100).toFixed(1) : 0;
//                 const subTr = document.createElement('tr');
//                 subTr.className = 'sub-row';
//                 subTr.innerHTML = `
//                     <td>↳ ${k2}</td>
//                     <td>${tree[k1].sub[k2].toLocaleString(undefined, {maximumFractionDigits:2})}</td>
//                     <td style="color:var(--text-muted); font-size:12px;">${share2}%</td>
//                 `;
//                 tbody.appendChild(subTr);
//             });
//         }
//     });
//
//     if(Object.keys(tree).length === 0) {
//         tbody.innerHTML = `<tr><td colspan="3" class="text-center">Нет данных для анализа</td></tr>`;
//     }
// }



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
  // --- ОБНОВЛЕННЫЙ ОБРАБОТЧИК КНОПКИ СРЕЗА ---
  document.getElementById('copy-slice-btn').addEventListener('click', () => {
      if (!state.finances.length) return alert('Нет данных для копирования.');

      // 1. Находим самую свежую (максимальную) дату среза в базе
      const maxDateStr = state.finances.reduce((max, item) =>
          new Date(item.date) > new Date(max) ? item.date : max, state.finances[0].date
      );

      // Передаем дату в интерфейс модального окна
      document.getElementById('modal-last-date').innerText = formatDate(maxDateStr);

      // 2. Подставляем сегодняшнее число как дату по умолчанию
      document.getElementById('modal-target-date').value = new Date().toISOString().split('T')[0];

      // Сохраняем исходную максимальную дату во временный атрибут кнопки подтверждения
      document.getElementById('confirm-copy-btn').setAttribute('data-source-date', maxDateStr);

      // 3. Показываем модальное окно
      const modal = document.getElementById('slice-modal');
      modal.classList.add('active');
      modal.style.visibility = 'visible';
  });

  // Обработчик для кнопки подтверждения внутри модального окна
  document.getElementById('confirm-copy-btn').addEventListener('click', async (e) => {
      const sourceDate = e.target.getAttribute('data-source-date');
      const targetDate = document.getElementById('modal-target-date').value;

      if (!targetDate) return alert('Пожалуйста, укажите корректную дату.');

      // Вытаскиваем все записи за исходную дату
      const lastSlice = state.finances.filter(f => f.date === sourceDate);

      // Создаем их точные копии, но заменяем дату на выбранную пользователем
      lastSlice.forEach(item => {
          state.finances.push({
              ...item,
              date: targetDate
          });
      });

      // Сохраняем в облако Firebase/Классическое хранилище и закрываем окно
      await saveToFirebase();
      closeSliceModal();
      renderAll();

      alert(`Успешно создано ${lastSlice.length} записей на дату ${formatDate(targetDate)}!`);
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

// Функция закрытия модального окна выбора даты
window.closeSliceModal = function() {
    const modal = document.getElementById('slice-modal');
    if (modal) {
        modal.classList.remove('active');
        modal.style.visibility = 'hidden';
    }
};


// --- ЛОГИКА РАБОТЫ СВОРАЧИВАЕМЫХ БЛОКОВ (ACCORDIONS) ---
// --- ИНТЕЛЛЕКТУАЛЬНЫЙ КОНТРОЛЛЕР СВОРАЧИВАНИЯ ОКНА (ACCORDION ENGINE) ---
window.toggleAccordion = function(accordionId) {
    const content = document.getElementById(accordionId);
    const arrow = document.getElementById(`arrow-${accordionId}`);

    if (!content || !arrow) return;

    // Проверяем, открыт ли текущий блок
    const isCurrentlyOpen = content.classList.contains('open');

    // Сначала принудительно закрываем ВСЕ остальные открытые меню, чтобы они не перекрывались
    document.querySelectorAll('.accordion-content').forEach(el => {
        el.classList.remove('open');
    });
    document.querySelectorAll('.acc-arrow').forEach(el => {
        el.classList.remove('rotated');
    });

    // Если блок был закрыт — открываем его
    if (!isCurrentlyOpen) {
        content.classList.add('open');
        arrow.classList.add('rotated');
    }
};

// Функция закрытия всех панелей управления на вкладке Аналитика
window.closeAllAnalyticsAccordions = function() {
    document.querySelectorAll('.accordion-content').forEach(el => {
        el.classList.remove('open');
    });
    document.querySelectorAll('.acc-arrow').forEach(el => {
        el.classList.remove('rotated');
    });
};

// ИНИЦИАЛИЗАЦИЯ ДЕТЕКТОРОВ УХОДА И КЛИКА ВНЕ БЛОКА
// Добавляем этот слушатель в общую очередь инициализации
document.addEventListener('DOMContentLoaded', () => {
    // 1. ДЛЯ СМАРТФОНОВ (iPhone): Закрытие тапом по любой области выше панели
    document.body.addEventListener('touchstart', (e) => {
        // Проверяем, если открыто хотя бы одно меню
        const openContent = document.querySelector('.accordion-content.open');
        if (!openContent) return;

        // Если палец коснулся элементов ВНУТРИ нижней панели управления — ничего не делаем
        if (e.target.closest('.analytics-controls')) return;

        // Во всех остальных случаях (клик выше по графикам/таблице) — автоматически сворачиваем панель
        closeAllAnalyticsAccordions();
    }, { passive: true });

    // 2. ДЛЯ КОМПЬЮТЕРОВ (ПК): Сворачивание, если мышка уходит вверх за пределы панели
    const controlsPanel = document.querySelector('.analytics-controls');
    if (controlsPanel) {
        controlsPanel.addEventListener('mouseleave', () => {
            closeAllAnalyticsAccordions();
        });
    }
});
