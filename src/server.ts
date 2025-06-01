import fastify from "fastify";
import * as crypto from "node:crypto";
import fastifyRawBody from "fastify-raw-body";

const {
    PORT = 5000,
    PYRUS_SECRET = "",
    GITLAB_TOKEN = "",
    GITLAB_API_BASE = "https://gitlab.example.com/api/v4",
    GITLAB_PROJECT_ID = "1",
    GITLAB_SCHEDULE_ID = "6",
    GITLAB_REF = "master",
    WAIT_MIN = "30",
} = process.env;

const WAIT = Number(WAIT_MIN);
const app = fastify({ logger: true });

await app.register(fastifyRawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true,
});

function gl(path: string, method: "GET" | "POST" = "GET") {
    return fetch(`${GITLAB_API_BASE}${path}`, {
        method,
        headers: { "PRIVATE-TOKEN": GITLAB_TOKEN, "Content-Type": "application/json" },
    });
}

async function hasActivePipeline(): Promise<boolean> {
    const url =
        `/projects/${GITLAB_PROJECT_ID}/pipelines` +
        `?ref=${encodeURIComponent(GITLAB_REF)}` +
        `&per_page=1&order_by=id&sort=desc`;

    const res = await gl(url);
    if (!res.ok) {
        app.log.error({ status: res.status }, "GitLab /pipelines failed");
        return true;
    }

    const [last] = (await res.json()) as any[];
    if (!last) return false;

    app.log.info({ id: last.id, status: last.status }, "last pipeline");
    return ["running", "pending"].includes(last.status);
}

async function playSchedule(): Promise<boolean> {
    const res = await gl(
        `/projects/${GITLAB_PROJECT_ID}/pipeline_schedules/${GITLAB_SCHEDULE_ID}/play`,
        "POST",
    );
    app.log.info({ status: res.status }, "play schedule result");
    return res.ok;
}

async function pyrusComment(task: number, token: string, text: string) {
    const r = await fetch(`https://api.pyrus.com/v4/tasks/${task}/comments`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
    });
    app.log.info({ status: r.status }, "comment sent");
}

app.post("/", { config: { rawBody: true } }, async (req, rep) => {
    const raw = req.rawBody as Buffer | undefined;
    if (!raw) return rep.code(400).send();

    const { task, access_token: token } = req.body as any;
    const taskId = task.id;

    if (await hasActivePipeline()) {
        await pyrusComment(
            taskId,
            token,
            `Пайплайн уже в работе / в очереди. Проверьте результат через ${WAIT} мин.`,
        );
        return rep.code(200).send();
    }

    if (await playSchedule()) {
        await pyrusComment(
            taskId,
            token,
            `Запустил пайплайн. Проверьте результат через ${WAIT} мин.`,
        );
    } else {
        await pyrusComment(
            taskId,
            token,
            "Не смог запустить: GitLab вернул ошибку. Позовите разработчика.",
        );
    }

    rep.code(200).send();
});

app.listen({ host: "0.0.0.0", port: Number(PORT) });
