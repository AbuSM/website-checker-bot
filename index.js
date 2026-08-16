require("dotenv").config();
const { Telegraf } = require("telegraf");
const { Database } = require("bun:sqlite");
const axios = require("axios");
const cron = require("node-cron");

const bot = new Telegraf(process.env.BOT_TOKEN);
const db = new Database("./websites.db");

// Инициализация таблиц
db.run(`
	CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY,
		username TEXT,
		first_name TEXT
	)
`);

db.run(`
	CREATE TABLE IF NOT EXISTS websites (
		id INTEGER PRIMARY KEY,
		url TEXT,
		last_status TEXT,
		user_id INTEGER,
		FOREIGN KEY (user_id) REFERENCES users(id)
	)
`);

// Миграция: добавить user_id если его нет (старая схема)
const columns = db.prepare("PRAGMA table_info(websites)").all();
if (!columns.some((c) => c.name === "user_id")) {
	db.run("ALTER TABLE websites ADD COLUMN user_id INTEGER REFERENCES users(id)");
}

// 🧑 Записываем или обновляем пользователя
const upsertUserStmt = db.prepare(
	`INSERT INTO users (id, username, first_name)
	 VALUES (?, ?, ?)
	 ON CONFLICT(id) DO UPDATE SET
		username = excluded.username,
		first_name = excluded.first_name`
);

function upsertUser(ctx) {
	const user = ctx.from;
	upsertUserStmt.run(user.id, user.username || "", user.first_name || "");
}

// Команда /start
bot.start((ctx) => {
	upsertUser(ctx);
	ctx.reply(
		"Привет! Отправь мне ссылку, и я буду следить за её доступностью."
	);
});

// Форматирует статус сайта
function formatStatus(status) {
	return status === "online"
		? "🟢 доступен"
		: status === "offline"
		? "🔴 не работает"
		: "⚪ проверяется";
}

// Формирует текст со списком сайтов пользователя (без кнопок)
function buildListMessage(userId) {
	const rows = db
		.prepare("SELECT id, url, last_status FROM websites WHERE user_id = ?")
		.all(userId);

	if (rows.length === 0) {
		return "Сайты не найдены.";
	}

	return rows.map((r) => `${r.url} — ${formatStatus(r.last_status)}`).join("\n");
}

// Формирует сообщение для удаления: список сайтов с кнопками-корзинами
function buildDeleteMessage(userId) {
	const rows = db
		.prepare("SELECT id, url, last_status FROM websites WHERE user_id = ?")
		.all(userId);

	if (rows.length === 0) {
		return { text: "Сайты не найдены.", keyboard: undefined };
	}

	const text = "Выбери сайт для удаления:";

	// По кнопке удаления на каждый сайт
	const keyboard = {
		inline_keyboard: rows.map((r) => [
			{ text: `🗑️ ${r.url}`, callback_data: `del:${r.id}` },
		]),
	};

	return { text, keyboard };
}

// Команда /list — показать сайты пользователя (без кнопок удаления)
bot.command("list", (ctx) => {
	upsertUser(ctx);
	ctx.reply(buildListMessage(ctx.from.id));
});

// Удаление сайта по нажатию inline-кнопки
bot.action(/^del:(\d+)$/, (ctx) => {
	upsertUser(ctx);
	const id = Number(ctx.match[1]);

	const result = db
		.prepare("DELETE FROM websites WHERE id = ? AND user_id = ?")
		.run(id, ctx.from.id);

	if (result.changes === 0) {
		return ctx.answerCbQuery("Сайт не найден.");
	}

	ctx.answerCbQuery("🗑️ Сайт удалён.");

	// Обновляем сообщение со списком для удаления
	const { text, keyboard } = buildDeleteMessage(ctx.from.id);
	ctx.editMessageText(text, keyboard ? { reply_markup: keyboard } : undefined);
});

// /delete — показать список сайтов с кнопками для выбора и удаления.
// /delete <url> — удалить конкретный сайт (старое поведение сохранено).
bot.command("delete", (ctx) => {
	upsertUser(ctx);
	const parts = ctx.message.text.split(" ").slice(1);

	// Без аргументов — показываем список сайтов с кнопками удаления
	if (parts.length === 0) {
		const { text, keyboard } = buildDeleteMessage(ctx.from.id);
		return ctx.reply(text, keyboard ? { reply_markup: keyboard } : undefined);
	}

	if (parts.length !== 1) return ctx.reply("Используй: /delete или /delete <url>");

	const url = parts[0].trim();
	const result = db.prepare("DELETE FROM websites WHERE url = ? AND user_id = ?").run(url, ctx.from.id);
	if (result.changes === 0) return ctx.reply("Сайт не найден.");
	ctx.reply(`🗑️ Сайт ${url} удалён.`);
});

// /update <old_url> <new_url>
bot.command("update", (ctx) => {
	upsertUser(ctx);
	const parts = ctx.message.text.split(" ").slice(1);
	if (parts.length !== 2)
		return ctx.reply("Используй: /update <старый_url> <новый_url>");

	const [oldUrl, newUrl] = parts;
	if (!/^https?:\/\//.test(newUrl)) {
		return ctx.reply("Новый URL должен начинаться с http:// или https://");
	}

	const result = db.prepare("UPDATE websites SET url = ?, last_status = 'unknown' WHERE url = ? AND user_id = ?").run(newUrl, oldUrl, ctx.from.id);
	if (result.changes === 0) return ctx.reply("Старый URL не найден.");
	ctx.reply(`✏️ Сайт обновлён: ${oldUrl} → ${newUrl}`);
});

// Добавление сайта по тексту
bot.on("text", (ctx) => {
	upsertUser(ctx);
	const url = ctx.message.text.trim();
	if (!/^https?:\/\//.test(url))
		return ctx.reply(
			"Пожалуйста, отправь корректный URL, начиная с http:// или https://"
		);

	try {
		db.prepare("INSERT INTO websites (url, last_status, user_id) VALUES (?, ?, ?)").run(url, "unknown", ctx.from.id);
		ctx.reply("Добавил сайт в список! Я буду проверять его каждые 5 минут.");
	} catch {
		ctx.reply("Ошибка при добавлении URL или он уже существует.");
	}
});

// Автоматическая проверка сайтов
const updateStatusStmt = db.prepare("UPDATE websites SET last_status = ? WHERE id = ?");

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

async function checkSite(url) {
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await axios.get(url, {
				timeout: 10000,
				headers: {
					"User-Agent": "Mozilla/5.0 (compatible; WebsiteCheckerBot/1.0)",
				},
				maxRedirects: 5,
				// Не даём axios бросать исключение — сами решаем по коду ответа
				validateStatus: () => true,
			});
			// 5xx (502, 503, 500…) означают, что сервер не работает для
			// посетителя — считаем сайт недоступным и пробуем ещё раз.
			if (response.status >= 500) {
				if (attempt < MAX_RETRIES) {
					await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
				}
				continue;
			}
			return true; // Ответ с кодом < 500 — сайт работает
		} catch (err) {
			// Сетевая ошибка или таймаут — пробуем ещё
			if (attempt < MAX_RETRIES) {
				await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
			}
		}
	}
	return false; // Все попытки провалились
}

// Проверяет, есть ли у самого бота доступ в интернет.
// Если интернета нет, нельзя считать сайты недоступными.
async function hasInternet() {
	const probes = [
		"https://www.google.com",
		"https://api.telegram.org",
		"https://1.1.1.1",
	];

	for (const url of probes) {
		try {
			await axios.head(url, {
				timeout: 5000,
				validateStatus: () => true,
			});
			return true; // Хоть один пробник ответил — интернет есть
		} catch {
			// Пробуем следующий
		}
	}
	return false;
}

// Один цикл проверки всех сайтов
async function runCheckCycle({ notify = true } = {}) {
	// Если у бота нет интернета — пропускаем цикл, чтобы не отмечать сайты
	// недоступными по ошибке.
	if (!(await hasInternet())) {
		console.warn("⚠️ Нет интернета — пропускаю проверку сайтов.");
		return;
	}

	const rows = db.prepare("SELECT * FROM websites").all();

	for (const row of rows) {
		const isOnline = await checkSite(row.url);

		if (isOnline && row.last_status !== "online") {
			updateStatusStmt.run("online", row.id);
			if (notify && row.last_status === "offline") {
				bot.telegram.sendMessage(
					row.user_id,
					`✅ Сайт ${row.url} снова доступен!`
				);
			}
		} else if (!isOnline && row.last_status !== "offline") {
			updateStatusStmt.run("offline", row.id);
			if (notify) {
				bot.telegram.sendMessage(
					row.user_id,
					`⚠️ Сайт ${row.url} недоступен!`
				);
			}
		}
	}
}

cron.schedule("*/5 * * * *", () => runCheckCycle());

// Глобальный обработчик ошибок — чтобы сбои в обработчиках были видны
bot.catch((err, ctx) => {
	console.error(`Ошибка при обработке обновления (${ctx?.updateType}):`, err);
});

// Запуск
bot
	.launch(() => {
		console.log("✅ Бот запущен и слушает обновления.");
		// Сразу проверяем все сайты при старте (без уведомлений),
		// чтобы статусы были актуальны, а не "проверяется" до первого крона.
		runCheckCycle({ notify: false }).catch((err) =>
			console.error("Ошибка стартовой проверки:", err)
		);
	})
	.catch((err) => {
		// Например, 409 Conflict, если уже запущен другой экземпляр
		console.error("❌ Не удалось запустить бота:", err);
		process.exit(1);
	});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
