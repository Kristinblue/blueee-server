<?php
declare(strict_types=1);

// 页宠聊天接口：把访客的消息转发给 DeepSeek，带上少量上下文和人设提示词。
// 限流结构与 comments.php 一致：浏览器 cookie 一道闸、IP 一道闸，
// 每道闸都有「最小间隔 / 5 分钟上限 / 24 小时上限」三层，事件存 MySQL。
// AI 的风格、限制都在文件顶部这几个常量里，想调整直接改这里。

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
// 任何 PHP 警告都不能混进 JSON 输出，只进日志
ini_set('display_errors', '0');

const CHAT_MODEL = 'deepseek-chat';
const CHAT_API_URL = 'https://api.deepseek.com/chat/completions';
const CHAT_API_TIMEOUT_SECONDS = 15;
const CHAT_MAX_TOKENS = 150;
const CHAT_IDLE_MAX_TOKENS = 60;
const CHAT_TEMPERATURE = 1.1;

// 上下文裁剪：只带最近几轮对话，每条都截短，控制 token 花费
const CHAT_HISTORY_MAX_ENTRIES = 6;
const CHAT_MESSAGE_MAX_CHARS = 200;
const CHAT_HISTORY_ENTRY_MAX_CHARS = 200;
const CHAT_HISTORY_TOTAL_MAX_CHARS = 3000;

// 限流：最小间隔只对 cookie 生效（IP 不限间隔）；每小时额度 cookie 50 条、IP 300 条；不做 24 小时上限
// [最小间隔秒(0=不限), 每小时上限]
const CHAT_BROWSER_LIMIT = [3, 50];
const CHAT_IP_LIMIT = [0, 300];

function respond(int $status, array $data): void
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function chat_length(string $content): int
{
    $count = preg_match_all('/./us', $content);
    return $count === false ? -1 : $count;
}

function visitor_cookie(): string
{
    // 和评论共用同一枚访客 cookie（path=/api），评论和聊天是同一个访客身份
    $visitor = $_COOKIE['comment_visitor'] ?? '';
    if (!is_string($visitor) || !preg_match('/^[a-f0-9]{64}$/D', $visitor)) {
        $visitor = bin2hex(random_bytes(32));
        $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (int) ($_SERVER['SERVER_PORT'] ?? 0) === 443;
        setcookie('comment_visitor', $visitor, [
            'expires' => time() + 365 * 24 * 60 * 60,
            'path' => '/api',
            'secure' => $https,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
    }
    return $visitor;
}

function note_catalog(): string
{
    // build 时生成的笔记索引，取标题给模型当推荐目录
    $graphPath = dirname(__DIR__) . '/generated/graph.json';
    $graph = json_decode((string) @file_get_contents($graphPath), true);
    if (!is_array($graph) || !isset($graph['nodes']) || !is_array($graph['nodes'])) {
        return '';
    }
    $titles = [];
    $total = 0;
    foreach ($graph['nodes'] as $node) {
        $title = isset($node['title']) && is_string($node['title']) ? trim($node['title']) : '';
        if ($title === '') {
            continue;
        }
        $title = mb_substr($title, 0, 40);
        $total += mb_strlen($title) + 1;
        if ($total > 900) {
            break;
        }
        $titles[] = $title;
    }
    return implode('、', $titles);
}

function system_prompt(string $idlePage = ''): string
{
    $catalog = note_catalog();
    $prompt = '你是个人学习笔记网站上的电子宠物小狗，陪访客学习、闲聊放松。'
        . '说话要求：口语化、轻松友好、自然；一条消息说完，不要列表、不要换行、不要 markdown、不要 emoji、不要颜文字；'
        . '回复简短，一般不超过 40 个字；不要自称「俺」，不要用「汪」之类的拟声词，像普通小伙伴一样正常说话。'
        . '网站内容是计算机视觉（OpenCV、Linux 等）学习笔记，目录：「' . $catalog . '」。'
        . '访客问站内内容时可以推荐目录里的笔记；不知道的就老实说不知道，不要编造；'
        . '遇到与学习无关的敏感话题就温和地带回学习本身。';
    if ($idlePage !== '') {
        $prompt .= '现在访客只是点了一下你，没有输入文字：你主动冒一句简短搭话，不超过 18 个字，'
            . '可以结合当前页面「' . $idlePage . '」说点鼓励或吐槽的话，别每次都是问候语。';
    }
    return $prompt;
}

function trimmed_history(mixed $history): array
{
    if (!is_array($history)) {
        return [];
    }
    $history = array_slice($history, -CHAT_HISTORY_MAX_ENTRIES);
    $messages = [];
    $total = 0;
    foreach ($history as $entry) {
        if (!is_array($entry) || !isset($entry['role'], $entry['content'])) {
            continue;
        }
        $role = $entry['role'] === 'assistant' ? 'assistant' : 'user';
        $content = trim((string) $entry['content']);
        if ($content === '') {
            continue;
        }
        $content = mb_substr($content, 0, CHAT_HISTORY_ENTRY_MAX_CHARS);
        $total += mb_strlen($content);
        if ($total > CHAT_HISTORY_TOTAL_MAX_CHARS) {
            break;
        }
        $messages[] = ['role' => $role, 'content' => $content];
    }
    return $messages;
}

function subject_times(PDO $db, string $key): array
{
    $stmt = $db->prepare('SELECT UNIX_TIMESTAMP(created_at) AS moment FROM chat_rate_events WHERE subject_key = ? AND created_at > UTC_TIMESTAMP(6) - INTERVAL 1 HOUR ORDER BY created_at DESC LIMIT 500');
    $stmt->execute([$key]);
    return array_map('floatval', $stmt->fetchAll(PDO::FETCH_COLUMN));
}

function limit_result(array $times, float $now, int $gap, int $hourlyMax): ?array
{
    if ($gap > 0 && $times && $now - $times[0] <= $gap) {
        $wait = max(1, (int) ceil($gap - ($now - $times[0])) + 1);
        return ['太快啦，歇 ' . $wait . ' 秒再聊～', $wait, 'gap'];
    }
    if (count($times) >= $hourlyMax) {
        $wait = max(60, (int) ceil(3600 - ($now - $times[$hourlyMax - 1])));
        $minutes = max(1, (int) ceil($wait / 60));
        return ['这个小时的聊天额度用完啦，约 ' . $minutes . ' 分钟后再来聊！', $wait, 'hour'];
    }
    return null;
}

function reserve_rate_subjects(PDO $db, array $keys): void
{
    sort($keys, SORT_STRING);
    $insert = $db->prepare('INSERT INTO chat_rate_subjects (subject_key, last_seen) VALUES (?, UTC_TIMESTAMP(6)) ON DUPLICATE KEY UPDATE last_seen = VALUES(last_seen)');
    $lock = $db->prepare('SELECT subject_key FROM chat_rate_subjects WHERE subject_key = ? FOR UPDATE');
    foreach ($keys as $key) {
        $insert->execute([$key]);
        $lock->execute([$key]);
        $lock->fetch();
        $lock->closeCursor();
    }
}

function call_deepseek(array $messages, int $maxTokens): ?string
{
    $config = $GLOBALS['chat_config'];
    $payload = json_encode([
        'model' => CHAT_MODEL,
        'messages' => $messages,
        'max_tokens' => $maxTokens,
        'temperature' => CHAT_TEMPERATURE,
        'stream' => false,
    ], JSON_UNESCAPED_UNICODE);
    $context = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json\r\nAuthorization: Bearer " . $config['deepseek_key'] . "\r\n",
            'content' => $payload,
            'timeout' => CHAT_API_TIMEOUT_SECONDS,
            'ignore_errors' => true,
        ],
    ]);
    $body = @file_get_contents(CHAT_API_URL, false, $context);
    if ($body === false) {
        return null;
    }
    $data = json_decode($body, true);
    $reply = $data['choices'][0]['message']['content'] ?? null;
    if (!is_string($reply)) {
        return null;
    }
    $reply = trim($reply);
    if ($reply === '') {
        return null;
    }
    // 模型偶尔不听话输出多行，压成一行再限个长度
    $reply = preg_replace('/\s*[\r\n]+\s*/u', ' ', $reply);
    return mb_substr($reply ?? '', 0, 500);
}

try {
    $configPath = getenv('COMMENTS_CONFIG_PATH') ?: dirname(__DIR__, 2) . '/website-comments-config.php';
    if (!is_file($configPath)) {
        throw new RuntimeException('Chat configuration is missing');
    }
    $config = require $configPath;
    if (!is_array($config) || empty($config['dsn']) || empty($config['user']) || !is_string($config['hash_key'] ?? null) || strlen($config['hash_key']) < 32) {
        throw new RuntimeException('Chat configuration is invalid');
    }
    if (!isset($config['deepseek_key']) || !is_string($config['deepseek_key']) || strlen($config['deepseek_key']) < 20) {
        throw new RuntimeException('DeepSeek key is missing');
    }
    $GLOBALS['chat_config'] = $config;

    $db = new PDO($config['dsn'], $config['user'], $config['password'] ?? '', [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    $db->exec("SET time_zone = '+00:00'");

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        header('Allow: POST');
        respond(405, ['error' => '请用 POST 和俺聊天。']);
    }
    if (stripos($_SERVER['CONTENT_TYPE'] ?? '', 'application/json') !== 0) {
        respond(415, ['error' => '请使用 JSON 提交。']);
    }
    $raw = file_get_contents('php://input', false, null, 0, 16385);
    if ($raw === false || strlen($raw) > 16384) {
        respond(413, ['error' => '消息太长啦。']);
    }
    $input = json_decode($raw, true);
    if (!is_array($input) || (!array_key_exists('message', $input) && !array_key_exists('type', $input))) {
        respond(400, ['error' => '消息格式无效。']);
    }
    // idle 模式：点小狗时的搭话请求，不需要正文，带当前页面标题即可
    $idle = isset($input['type']) && $input['type'] === 'idle';
    $message = isset($input['message']) && is_string($input['message']) ? trim($input['message']) : '';
    if (!$idle) {
        $length = chat_length($message);
        if ($length < 1 || $length > CHAT_MESSAGE_MAX_CHARS) {
            respond(400, ['error' => '消息需要在 1 到 ' . CHAT_MESSAGE_MAX_CHARS . ' 字之间。']);
        }
    }
    $page = '';
    if ($idle && isset($input['page']) && is_string($input['page'])) {
        $page = trim(preg_replace('/[<>\\x{00}-\\x{1f}「」]/u', '', $input['page']) ?? '');
        $page = mb_substr($page, 0, 60);
    }
    $history = $idle ? [] : trimmed_history($input['history'] ?? []);

    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    $packedIp = filter_var($ip, FILTER_VALIDATE_IP) ? inet_pton($ip) : false;
    if ($packedIp === false) {
        throw new RuntimeException('Client IP is unavailable');
    }
    $visitor = visitor_cookie();
    $browserKey = hash_hmac('sha256', "browser\0" . $visitor, $config['hash_key']);
    $ipKey = hash_hmac('sha256', "ip\0" . $packedIp, $config['hash_key']);

    // 先记账再调 AI：即使上游挂了，刷子也已经把额度花掉了
    $db->beginTransaction();
    try {
        reserve_rate_subjects($db, [$browserKey, $ipKey]);
        $now = (float) $db->query('SELECT UNIX_TIMESTAMP(UTC_TIMESTAMP(6))')->fetchColumn();
        $browserLimit = limit_result(subject_times($db, $browserKey), $now, CHAT_BROWSER_LIMIT[0], CHAT_BROWSER_LIMIT[1]);
        $ipLimit = limit_result(subject_times($db, $ipKey), $now, CHAT_IP_LIMIT[0], CHAT_IP_LIMIT[1]);
        $limit = $browserLimit ?? $ipLimit;
        if ($limit !== null) {
            $db->rollBack();
            header('Retry-After: ' . $limit[1]);
            respond(429, ['error' => $limit[0], 'retryAfter' => $limit[1], 'kind' => $limit[2]]);
        }        $event = $db->prepare('INSERT INTO chat_rate_events (subject_key, created_at) VALUES (?, UTC_TIMESTAMP(6))');
        $event->execute([$browserKey]);
        $event->execute([$ipKey]);
        $db->commit();
    } catch (Throwable $error) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $error;
    }
    if (random_int(1, 20) === 1) {
        try {
            $db->exec('DELETE FROM chat_rate_events WHERE created_at <= UTC_TIMESTAMP(6) - INTERVAL 2 HOUR LIMIT 1000');
            $db->exec('DELETE FROM chat_rate_subjects WHERE last_seen <= UTC_TIMESTAMP(6) - INTERVAL 1 DAY LIMIT 1000');
        } catch (Throwable $error) {
            error_log('Chat rate cleanup: ' . $error->getMessage());
        }
    }

    $messages = array_merge(
        [['role' => 'system', 'content' => system_prompt($page)]],
        $history,
        [['role' => 'user', 'content' => $idle ? '（访客刚点了一下你）' : $message]],
    );
    $reply = call_deepseek($messages, $idle ? CHAT_IDLE_MAX_TOKENS : CHAT_MAX_TOKENS);
    if ($reply === null) {
        // 上游失败：告诉前端回落到本地台词，别让小狗失声
        error_log('Chat API: deepseek upstream failed');
        respond(502, ['error' => 'AI 暂时不可用', 'fallback' => true]);
    }
    respond(200, ['reply' => $reply]);
} catch (Throwable $error) {
    error_log('Chat API: ' . $error->getMessage());
    respond(503, ['error' => '聊天服务暂时不可用', 'fallback' => true]);
}
