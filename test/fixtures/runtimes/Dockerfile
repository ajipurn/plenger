# The web image: pinned to the last 8.3 release before the PHP2Shell fix.
ARG PHP_VERSION=8.3.35

# Composer and asset stages only feed the final image; they do not ship.
FROM composer:2 AS vendor
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-scripts

FROM php:8.2-cli AS assets
RUN php -r 'echo "built";' > /built.txt

FROM php:${PHP_VERSION}-apache AS app
COPY --from=vendor /app/vendor /var/www/html/vendor
COPY --from=assets /built.txt /var/www/html/built.txt
COPY docker/php/conf.d/php2shell.ini /usr/local/etc/php/conf.d/
COPY public/ /var/www/html/
