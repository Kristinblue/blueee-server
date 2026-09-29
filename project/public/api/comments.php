<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function respond(int $status, array $data): void
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function comment_length(string $content): int
{
    $count = preg_match_all('/./us', $content);
    return $count === false ? -1 : $count;
}

function valid_note(string $note): bool
{
    if ($note === '' || strlen($note) > 2048 || comment_length($note) > 512) {
        return false;
    }
    $graphPath = dirname(__DIR__) . '/generated/graph.json';
    $graph = json_decode((string) @file_get_contents($graphPath), true);
    if (!is_array($graph) || !isset($graph['nodes']) || !is_array($graph['nodes'])) {
        throw new RuntimeException('Published note index is unavailable');
    }
    foreach ($graph['nodes'] as $node) {
        if (isset($node['id']) && $node['id'] === $note) {
            return true;
        }
    }
    return false;
}

function public_comment(array $row, ?int $replyCount = null): array
{
    $comment = [
        'id' => (int) $row['id'],
        'parentId' => isset($row['parent_id']) && $row['parent_id'] !== null ? (int) $row['parent_id'] : null,
        'authorName' => $row['author_name'] ?? null,
        'content' => $row['content'],
        'createdAt' => str_replace(' ', 'T', substr($row['created_at'], 0, 19)) . 'Z',
    ];
    if ($replyCount !== null) {
        $comment['replyCount'] = $replyCount;
    }
    return $comment;
}

function name_bank(): array
{
    // 访客昵称词库：形容词 + 名词各 48 个，中英各半，可混搭（如 勇敢Panda、Brave柴犬）。
    // 想扩充直接往数组加词即可；已分配的昵称存在 comment_identities 表里，不受词库变动影响。
    return [
        'adj' => [
            'zh' => ['勇敢', '温柔', '快乐', '聪明', '认真', '可爱', '开朗', '沉稳', '灵巧', '诚实',
                     '热心', '勤奋', '机智', '从容', '大方', '细心', '乐观', '专注', '谦和', '稳健',
                     '敏捷', '善良', '巧妙', '睿智', '活泼', '踏实', '灵动', '爽朗', '耐心', '纯真',
                     '悠然', '磊落', '明朗', '灿烂', '和煦', '赤诚', '笃定', '谦逊', '灵秀', '自在',
                     '热忱', '俊逸', '飒爽', '恬静', '蓬勃', '昂扬', '沉着', '温润'],
            'en' => ['Brave', 'Gentle', 'Happy', 'Clever', 'Earnest', 'Sunny', 'Cheerful', 'Calm', 'Nimble', 'Honest',
                     'Warm', 'Diligent', 'Witty', 'Serene', 'Gracious', 'Keen', 'Optimistic', 'Focused', 'Humble', 'Steady',
                     'Agile', 'Kind', 'Wise', 'Lively', 'Patient', 'Pure', 'Mellow', 'Bright', 'Genuine', 'Bold',
                     'Sincere', 'Radiant', 'Cozy', 'Daring', 'Tender', 'Curious', 'Playful', 'Quiet', 'Jolly', 'Plucky',
                     'Merry', 'Crisp', 'Glowing', 'Fearless', 'Amiable', 'Sturdy', 'Snappy', 'Zesty'],
        ],
        'noun' => [
            'zh' => ['柴犬', '月亮', '海豚', '星辰', '面包', '番茄', '柠檬', '桃子', '云朵', '春风',
                     '萤火', '松鼠', '企鹅', '熊猫', '湖泊', '山丘', '灯塔', '竹林', '麦田', '咖啡',
                     '奶茶', '团子', '布丁', '曲奇', '橘猫', '白鲸', '极光', '晨露', '晚风', '诗集',
                     '口琴', '风筝', '纸鸢', '气球', '葵花', '小巷', '木桥', '浅滩', '星轨', '蜂蜜',
                     '汽水', '西瓜', '板栗', '银杏', '苔藓', '海螺', '贝壳', '灯笼'],
            'en' => ['Panda', 'Dolphin', 'Bunny', 'Otter', 'Sunrise', 'Harbor', 'Meadow', 'Comet', 'Biscuit', 'Muffin',
                     'Latte', 'Cocoa', 'Peach', 'Lemon', 'Melon', 'Willow', 'Maple', 'Cedar', 'Brook', 'Ember',
                     'Aurora', 'Dewdrop', 'Breeze', 'Sonnet', 'Kite', 'Balloon', 'Sunflower', 'Alley', 'Bridge', 'Starling',
                     'Seashell', 'Lantern', 'Honey', 'Soda', 'Walnut', 'Ginkgo', 'Moss', 'Conch', 'Acorn', 'Penguin',
                     'Squirrel', 'Firefly', 'Sparrow', 'Pudding', 'Cookie', 'Noodle', 'Whistle', 'Blossom'],
        ],
    ];
}

function derive_name(string $authorKey, int $attempt, string $hashKey): string
{
    $bytes = hash_hmac('sha256', "name\0{$authorKey}\0{$attempt}", $hashKey, true);
    $rolls = unpack('N4', substr($bytes, 0, 16));
    $bank = name_bank();
    $adjectives = $bank['adj'][($rolls[1] & 1) === 1 ? 'en' : 'zh'];
    $nouns = $bank['noun'][($rolls[2] & 1) === 1 ? 'en' : 'zh'];
    return $adjectives[intdiv($rolls[1], 2) % count($adjectives)] . $nouns[intdiv($rolls[2], 2) % count($nouns)];
}

function assign_identity(PDO $db, string $authorKey, string $hashKey): string
{
    $find = $db->prepare('SELECT display_name FROM comment_identities WHERE author_key = ?');
    $find->execute([$authorKey]);
    $existing = $find->fetchColumn();
    if ($existing !== false) {
        return (string) $existing;
    }
    // 注册制分配：display_name 有唯一索引，撞名（或并发抢注）时换下一个候选，
    // 保证全站昵称不重复；候选由哈希逐个派生，与浏览器稳定绑定。
    $insert = $db->prepare('INSERT INTO comment_identities (author_key, display_name, created_at) VALUES (?, ?, UTC_TIMESTAMP(6))');
    for ($attempt = 0; $attempt < 256; $attempt++) {
        try {
            $name = derive_name($authorKey, $attempt, $hashKey);
            $insert->execute([$authorKey, $name]);
            return $name;
        } catch (PDOException $error) {
            if ($error->getCode() !== '23000') {
                throw $error;
            }
            $find->execute([$authorKey]);
            $existing = $find->fetchColumn();
            if ($existing !== false) {
                return (string) $existing;
            }
        }
    }
    throw new RuntimeException('Nickname space is exhausted');
}

function visitor_cookie(array $config): string
{
    $visitor = $_COOKIE['comment_visitor'] ?? '';
    if (!is_string($visitor) || !preg_match('/^[a-f0-9]{64}$/D', $visitor)) {
        $visitor = bin2hex(random_bytes(32));
        $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (int) ($_SERVER['SERVER_PORT'] ?? 0) === 443;
        $options = [
            'expires' => time() + 365 * 24 * 60 * 60,
            'path' => '/api',
            'secure' => $https,
            'httponly' => true,
            'samesite' => 'Lax',
        ];
        if (!empty($config['cookie_domain'])) {
            $options['domain'] = $config['cookie_domain'];
        }
        setcookie('comment_visitor', $visitor, $options);
    }
    return $visitor;
}

function subject_times(PDO $db, string $key): array
{
    $stmt = $db->prepare('SELECT UNIX_TIMESTAMP(created_at) AS moment FROM comment_rate_events WHERE subject_key = ? AND created_at > UTC_TIMESTAMP(6) - INTERVAL 24 HOUR ORDER BY created_at DESC LIMIT 200');
    $stmt->execute([$key]);
    return array_map('floatval', $stmt->fetchAll(PDO::FETCH_COLUMN));
}

function find_comment_root(PDO $db, int $id, string $note): ?int
{
    $stmt = $db->prepare('SELECT id, note_slug, status, root_id FROM comments WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    if (!$row || $row['note_slug'] !== $note || $row['status'] !== 'visible') {
        return null;
    }
    return $row['root_id'] === null ? (int) $row['id'] : (int) $row['root_id'];
}

function limit_result(array $times, float $now, int $gap, int $fiveMinuteMax, int $dayMax, string $name): ?array
{
    if ($times && $now - $times[0] <= $gap) {
        return ["{$name}发送得太快了，请稍后重试。", max(1, (int) ceil($gap - ($now - $times[0])) + 1)];
    }
    $recent = array_values(array_filter($times, static fn (float $moment): bool => $moment > $now - 300));
    if (count($recent) >= $fiveMinuteMax) {
        return ["{$name}在 5 分钟内已达到评论上限。", max(1, (int) ceil(300 - ($now - $recent[$fiveMinuteMax - 1])))];
    }
    if (count($times) >= $dayMax) {
        return ["{$name}在 24 小时内已达到评论上限。", max(1, (int) ceil(86400 - ($now - $times[$dayMax - 1])))];
    }
    return null;
}

function reserve_rate_subjects(PDO $db, array $keys): void
{
    sort($keys, SORT_STRING);
    $insert = $db->prepare('INSERT INTO comment_rate_subjects (subject_key, last_seen) VALUES (?, UTC_TIMESTAMP(6)) ON DUPLICATE KEY UPDATE last_seen = VALUES(last_seen)');
    $lock = $db->prepare('SELECT subject_key FROM comment_rate_subjects WHERE subject_key = ? FOR UPDATE');
    foreach ($keys as $key) {
        $insert->execute([$key]);
        $lock->execute([$key]);
        $lock->fetch();
        $lock->closeCursor();
    }
}

try {
    $configPath = getenv('COMMENTS_CONFIG_PATH') ?: dirname(__DIR__, 2) . '/website-comments-config.php';
    if (!is_file($configPath)) {
        throw new RuntimeException('Comment configuration is missing');
    }
    $config = require $configPath;
    if (!is_array($config) || empty($config['dsn']) || empty($config['user']) || !is_string($config['hash_key'] ?? null) || strlen($config['hash_key']) < 32) {
        throw new RuntimeException('Comment configuration is invalid');
    }
    $db = new PDO($config['dsn'], $config['user'], $config['password'] ?? '', [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    $db->exec("SET time_zone = '+00:00'");

    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        $note = $_GET['note'] ?? '';
        if (!is_string($note) || !valid_note($note)) {
            respond(400, ['error' => '这篇笔记不存在。']);
        }
        $visitorName = null;
        $rawVisitor = $_COOKIE['comment_visitor'] ?? '';
        if (is_string($rawVisitor) && preg_match('/^[a-f0-9]{64}$/D', $rawVisitor)) {
            $whoKey = hash_hmac('sha256', "browser\0" . $rawVisitor, $config['hash_key']);
            $who = $db->prepare('SELECT display_name FROM comment_identities WHERE author_key = ?');
            $who->execute([$whoKey]);
            $found = $who->fetchColumn();
            $visitorName = $found === false ? null : (string) $found;
        }
        $parent = $_GET['parent'] ?? null;
        if ($parent !== null) {
            if (!is_string($parent) || !ctype_digit($parent) || (int) $parent < 1) {
                respond(400, ['error' => '回复参数无效。']);
            }
            $rootId = find_comment_root($db, (int) $parent, $note);
            if ($rootId === null) {
                respond(404, ['error' => '要查看的评论不存在。']);
            }
            $after = $_GET['after'] ?? null;
            if ($after !== null && (!is_string($after) || !ctype_digit($after) || (int) $after < 1)) {
                respond(400, ['error' => '分页参数无效。']);
            }
            $sql = "SELECT id, parent_id, author_name, content, created_at FROM comments WHERE note_slug = ? AND root_id = ? AND status = 'visible'";
            $params = [$note, $rootId];
            if ($after !== null) {
                $sql .= ' AND id > ?';
                $params[] = (int) $after;
            }
            $sql .= ' ORDER BY id ASC LIMIT 21';
            $stmt = $db->prepare($sql);
            $stmt->execute($params);
            $rows = $stmt->fetchAll();
            $hasMore = count($rows) > 20;
            $rows = array_slice($rows, 0, 20);
            respond(200, [
                'comments' => array_map('public_comment', $rows),
                'visitorName' => $visitorName,
                'nextAfter' => $hasMore ? (int) end($rows)['id'] : null,
            ]);
        }
        $before = $_GET['before'] ?? null;
        if ($before !== null && (!is_string($before) || !ctype_digit($before) || (int) $before < 1)) {
            respond(400, ['error' => '分页参数无效。']);
        }
        $sql = "SELECT id, parent_id, author_name, content, created_at FROM comments WHERE note_slug = ? AND parent_id IS NULL AND status = 'visible'";
        $params = [$note];
        if ($before !== null) {
            $sql .= ' AND id < ?';
            $params[] = (int) $before;
        }
        $sql .= ' ORDER BY id DESC LIMIT 21';
        $stmt = $db->prepare($sql);
        $stmt->execute($params);
        $rows = $stmt->fetchAll();
        $hasMore = count($rows) > 20;
        $rows = array_slice($rows, 0, 20);
        $replyCounts = [];
        if ($rows) {
            $ids = implode(',', array_map(static fn (array $row): int => (int) $row['id'], $rows));
            $countStmt = $db->query("SELECT root_id, COUNT(*) AS total FROM comments WHERE root_id IN ($ids) AND status = 'visible' GROUP BY root_id");
            foreach ($countStmt->fetchAll() as $countRow) {
                $replyCounts[(int) $countRow['root_id']] = (int) $countRow['total'];
            }
        }
        respond(200, [
            'comments' => array_map(static fn (array $row): array => public_comment($row, $replyCounts[(int) $row['id']] ?? 0), $rows),
            'visitorName' => $visitorName,
            'nextBefore' => $hasMore ? (int) end($rows)['id'] : null,
        ]);
    }

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        header('Allow: GET, POST');
        respond(405, ['error' => '不支持此请求方式。']);
    }
    if (stripos($_SERVER['CONTENT_TYPE'] ?? '', 'application/json') !== 0) {
        respond(415, ['error' => '请使用 JSON 提交评论。']);
    }
    $raw = file_get_contents('php://input', false, null, 0, 8193);
    if ($raw === false || strlen($raw) > 8192) {
        respond(413, ['error' => '评论内容太长。']);
    }
    $input = json_decode($raw, true);
    if (!is_array($input) || !isset($input['note'], $input['content']) || !is_string($input['note']) || !is_string($input['content'])) {
        respond(400, ['error' => '评论格式无效。']);
    }
    $note = $input['note'];
    $content = trim($input['content']);
    if (!valid_note($note)) {
        respond(400, ['error' => '这篇笔记不存在。']);
    }
    $length = comment_length($content);
    if ($length < 1 || $length > 1000) {
        respond(400, ['error' => '评论需要在 1 到 1000 字之间。']);
    }
    $parentId = $input['parentId'] ?? null;
    if ($parentId !== null && (!is_int($parentId) || $parentId < 1)) {
        respond(400, ['error' => '要回复的评论无效。']);
    }
    $rootId = null;
    if ($parentId !== null) {
        $rootId = find_comment_root($db, $parentId, $note);
        if ($rootId === null) {
            respond(404, ['error' => '要回复的评论不存在。']);
        }
    }

    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    $packedIp = filter_var($ip, FILTER_VALIDATE_IP) ? inet_pton($ip) : false;
    if ($packedIp === false) {
        throw new RuntimeException('Client IP is unavailable');
    }
    $visitor = visitor_cookie($config);
    $browserKey = hash_hmac('sha256', "browser\0" . $visitor, $config['hash_key']);
    $ipKey = hash_hmac('sha256', "ip\0" . $packedIp, $config['hash_key']);

    $db->beginTransaction();
    try {
        reserve_rate_subjects($db, [$browserKey, $ipKey]);
        $now = (float) $db->query('SELECT UNIX_TIMESTAMP(UTC_TIMESTAMP(6))')->fetchColumn();
        $browserLimit = limit_result(subject_times($db, $browserKey), $now, 5, 10, 20, '同一浏览器');
        $ipLimit = limit_result(subject_times($db, $ipKey), $now, 1, 50, 200, '当前网络');
        $limit = $browserLimit ?? $ipLimit;
        if ($limit !== null) {
            $db->rollBack();
            header('Retry-After: ' . $limit[1]);
            respond(429, ['error' => $limit[0], 'retryAfter' => $limit[1]]);
        }
        $authorName = assign_identity($db, $browserKey, $config['hash_key']);
        $stmt = $db->prepare("INSERT INTO comments (note_slug, parent_id, root_id, author_key, author_name, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'visible', UTC_TIMESTAMP(6))");
        $stmt->execute([$note, $parentId, $rootId, $browserKey, $authorName, $content]);
        $id = (int) $db->lastInsertId();
        $event = $db->prepare('INSERT INTO comment_rate_events (subject_key, comment_id, created_at) VALUES (?, ?, UTC_TIMESTAMP(6))');
        $event->execute([$browserKey, $id]);
        $event->execute([$ipKey, $id]);
        $db->commit();
    } catch (Throwable $error) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $error;
    }
    if (random_int(1, 20) === 1) {
        try {
            $db->exec('DELETE FROM comment_rate_events WHERE created_at <= UTC_TIMESTAMP(6) - INTERVAL 24 HOUR LIMIT 1000');
            $db->exec('DELETE FROM comment_rate_subjects WHERE last_seen <= UTC_TIMESTAMP(6) - INTERVAL 2 DAY LIMIT 1000');
        } catch (Throwable $error) {
            error_log('Comment rate cleanup: ' . $error->getMessage());
        }
    }
    $stmt = $db->prepare('SELECT id, parent_id, author_name, content, created_at FROM comments WHERE id = ?');
    $stmt->execute([$id]);
    respond(201, ['comment' => public_comment($stmt->fetch())]);
} catch (Throwable $error) {
    error_log('Comment API: ' . $error->getMessage());
    respond(503, ['error' => '评论服务暂时不可用，请稍后重试。']);
}
