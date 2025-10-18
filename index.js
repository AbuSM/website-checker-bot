require("dotenv").config();
const { Telegraf } = require("telegraf");
const sqlite3 = require("sqlite3").verbose();
const axios = require("axios");
const cron = require("node-cron");

const bot = new Telegraf(process.env.BOT_TOKEN);
const db = new sqlite3.Database("./websites.db");

// Инициализация таблицы
db.serialize(() => {
	db.run(
		"CREATE TABLE IF NOT EXISTS websites (id INTEGER PRIMARY KEY, url TEXT, last_status TEXT)"
	);
});

// Команда /start
bot.start((ctx) =>
	ctx.reply(
		"Привет! Отправь мне ссылку, и я буду следить за её доступностью."
	)
);

// Команда /list — показать все сайты
bot.command("list", (ctx) => {
	db.all("SELECT url, last_status FROM websites", (err, rows) => {
		if (err || rows.length === 0) return ctx.reply("Сайты не найдены.");
		const msg = rows
			.map(
				(r) =>
					`${r.url} — ${
						r.last_status === "online"
							? "🟢 доступен"
							: "🔴 не работает"
					}`
			)
			.join("\n");
		ctx.reply(msg);
	});
});

// При получении текста — пробуем сохранить URL
bot.on("text", (ctx) => {
	const url = ctx.message.text.trim();
	if (!/^https?:\/\//.test(url))
		return ctx.reply(
			"Пожалуйста, отправь корректный URL, начиная с http:// или https://"
		);

	db.run(
		"INSERT INTO websites (url, last_status) VALUES (?, ?)",
		[url, "unknown"],
		(err) => {
			if (err)
				return ctx.reply(
					"Ошибка при добавлении URL или он уже существует."
				);
			ctx.reply(
				"Добавил сайт в список! Я буду проверять его каждые 5 минут."
			);
		}
	);
});

// Периодическая проверка сайтов
cron.schedule("*/5 * * * *", () => {
	db.all("SELECT * FROM websites", (err, rows) => {
		if (err) return console.error("Ошибка при чтении БД:", err.message);

		rows.forEach((row) => {
			axios
				.get(row.url, { timeout: 5000 })
				.then(() => {
					if (row.last_status !== "online") {
						db.run(
							"UPDATE websites SET last_status = ? WHERE id = ?",
							["online", row.id]
						);
					}
				})
				.catch(() => {
					if (row.last_status !== "offline") {
						db.run(
							"UPDATE websites SET last_status = ? WHERE id = ?",
							["offline", row.id]
						);
						const userId =
							process.env.ADMIN_ID || "your_admin_telegram_id";
						bot.telegram.sendMessage(
							userId,
							`⚠️ Сайт ${row.url} недоступен!`
						);
					}
				});
		});
	});
});

// Запуск бота
bot.launch();

// Завершение по сигналам
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
