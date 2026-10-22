<?php
// Meant as the PHP2Shell mitigation; the setting cannot be changed at runtime.
ini_set('session.upload_progress.enabled', '0');
session_start();
echo 'ok';
