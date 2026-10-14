// import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
// import { getAnalytics } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-analytics.js";


// Конфигурация вашего Firebase проекта
const firebaseConfig = {
  apiKey: "AIzaSyDa3QDryzVTlVQIjTX_RBLUGqyfhgO80X0",
  authDomain: "networth-4591c.firebaseapp.com",
  projectId: "networth-4591c",
  storageBucket: "networth-4591c.firebasestorage.app",
  messagingSenderId: "894703958234",
  appId: "1:894703958234:web:f811b1595faeb433a1cde3",
  measurementId: "G-VXS2Y00RR0"
};


// Инициализируем Firebase, если ключи подставлены
if (firebaseConfig.apiKey !== "YOUR_API_KEY") {
    firebase.initializeApp(firebaseConfig);
    window.db = firebase.firestore();
    // const app = initializeApp(firebaseConfig);
    // const analytics = getAnalytics(app);
} else {
    console.warn("Firebase не сконфигурирован. Приложение работает в автономном режиме LocalStorage.");
    window.db = null;
}
