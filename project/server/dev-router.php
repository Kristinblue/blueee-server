<?php
// Router for PHP's local development server. Production uses Nginx.
$root = realpath(__DIR__ . '/../dist');
$path = rawurldecode((string) parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));
$target = realpath($root . $path);

if ($target !== false && ($target === $root || str_starts_with($target, $root . DIRECTORY_SEPARATOR))) {
    if (is_file($target)) {
        return false;
    }
    if (is_dir($target) && is_file($target . '/index.html')) {
        header('Content-Type: text/html; charset=utf-8');
        readfile($target . '/index.html');
        return true;
    }
}

http_response_code(404);
echo 'Not Found';
