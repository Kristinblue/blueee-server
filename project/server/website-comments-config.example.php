<?php
// Copy to /www/wwwroot/website-comments-config.php, outside the public site root.
return [
    'dsn' => 'mysql:host=127.0.0.1;port=3306;dbname=website_comments;charset=utf8mb4',
    'user' => 'website_comments',
    'password' => 'REPLACE_WITH_DATABASE_PASSWORD',
    'hash_key' => 'REPLACE_WITH_A_LONG_RANDOM_SECRET',
    'cookie_domain' => null, // On the server, set to 'blueee.cn' to cover www.blueee.cn too.
];
