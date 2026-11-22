# Suno Playlist Player

Suno Playlist Player adalah aplikasi web Node.js untuk memutar playlist publik Suno. Admin mengelola daftar playlist dan pengaturan aplikasi lewat panel admin. Aplikasi ini tidak berafiliasi dengan Suno.

## Fitur

- Memutar playlist dan lagu Suno melalui browser.
- Mengelola playlist dari panel admin.
- Mencari lagu, melihat detail dan komentar, serta membuat antrean pemutaran.
- Menyimpan lagu atau seluruh playlist ke cache offline browser dengan estimasi ukuran.
- Mengunduh audio dengan PIN unduhan.
- Mengirim notifikasi lagu baru melalui browser push setelah pengunjung memberi izin.
- Menyesuaikan nama aplikasi, teks halaman, warna aksen, dan batas cache.

Folder ini memulai aplikasi dengan playlist kosong. Tidak ada tombol donasi.

## Persyaratan

- Node.js 18 atau lebih baru.
- npm.
- Koneksi internet untuk mengambil data dan audio dari Suno.

## Pemasangan dan menjalankan

Di terminal, buka folder `universal`, lalu jalankan:

```bash
npm ci
npm start
```

Buka `http://localhost:3000`. Jika port 3000 sudah dipakai, tentukan port lain:

```bash
PORT=4173 npm start
```

Server membaca `PORT` dan `HOST` dari environment. Default port adalah `3000`, dan default host adalah `0.0.0.0`.

## Panel admin dan PIN

Buka `/nugaduhna` pada origin aplikasi yang sama. Pada pemasangan baru, PIN login admin dan PIN unduhan audio sama-sama `123456`.

Segera ubah kedua PIN dari panel admin sebelum membuka aplikasi ke jaringan publik. Panel menyediakan pengaturan terpisah untuk PIN login dan PIN unduhan. Masing-masing harus terdiri dari 4 sampai 10 digit. Nilai PIN yang disimpan panel admin berbentuk hash di `admin-pins.json`.

Environment `ADMIN_PIN` dan `DOWNLOAD_PIN` dapat menentukan PIN awal saat server mulai. Setelah PIN diubah dari panel, nilai dalam `admin-pins.json` akan digunakan lebih dahulu. Karena PIN awal `123456` tercantum di kode, jangan biarkan PIN itu aktif pada deployment publik.

## Membuat playlist

Playlist kosong disediakan melalui `playlists.json`. Masuk ke panel admin untuk membuat playlist dan menambahkan lagu menggunakan tautan lagu Suno. Setelah ditambahkan, playlist akan muncul di halaman utama.

Admin juga dapat mengubah pengaturan aplikasi, PIN, notifikasi, dan batas cache offline. Pengaturan aplikasi tersimpan di `config.json`.
Jika file pengaturan atau playlist belum ada, server memakai pengaturan bawaan dan daftar playlist kosong.

## Pengaturan environment

| Variabel | Kegunaan |
| --- | --- |
| `PORT` | Port HTTP server. Default `3000`. |
| `HOST` | Alamat bind server. Default `0.0.0.0`. |
| `ADMIN_PIN` | PIN login awal. Default `123456`. |
| `DOWNLOAD_PIN` | PIN unduhan awal. Default `123456`. |
| `SUNO_TOKEN` | Token sesi Suno server-side untuk playlist privat. Playlist publik tidak memerlukannya. |
| `PUBLIC_ORIGIN` | Origin publik, misalnya `https://player.example.com`. Atur jika aplikasi berada di belakang reverse proxy. |
| `VAPID_SUBJECT` | Alamat kontak untuk Web Push, sebaiknya `mailto:alamat-anda`. Default memakai alamat contoh `mailto:admin@example.com`. |

Contoh menjalankan server dengan PIN awal dan token Suno:

```bash
ADMIN_PIN=123456 DOWNLOAD_PIN=123456 SUNO_TOKEN="token-anda" npm start
```

Jangan masukkan token atau nilai rahasia ke file yang akan dipush. Simpan environment rahasia di konfigurasi host deployment.

## HTTPS dan notifikasi browser

Service worker, cache offline, dan notifikasi push memerlukan secure context. `localhost` dapat digunakan untuk pengembangan. Untuk akses melalui jaringan atau internet, gunakan HTTPS.

Jika memasang aplikasi di belakang reverse proxy, teruskan host permintaan dengan benar dan atur `PUBLIC_ORIGIN` ke origin HTTPS yang dipakai pengunjung. Untuk Web Push, ganti `VAPID_SUBJECT` dengan alamat kontak yang dikelola pemilik aplikasi.

## Data dan privasi

Server menyimpan pengaturan dan playlist di file JSON lokal. File data muncul saat server atau fitur terkait membutuhkannya. `web-push-keys.json` dibuat saat server pertama kali berjalan. File yang mungkin muncul antara lain:

- `config.json`
- `playlists.json`
- `comments.json`
- `likes.json`
- `play-counts.json`
- `admin-notifications.json`
- `admin-pins.json`
- `web-push-keys.json`
- `push-subscriptions.json`

Cache audio offline tersimpan di browser masing-masing pengunjung. `web-push-keys.json`, `push-subscriptions.json`, dan `admin-pins.json` berisi data privat. Jangan commit file-file tersebut. `.gitignore` di folder ini mengecualikan file runtime dan environment lokal.

Simpan cadangan file data dan kunci Web Push di tempat privat. Jika kunci Web Push hilang atau diganti, pengunjung mungkin perlu mengaktifkan notifikasi lagi.

## Pemecahan masalah

- **Port sudah dipakai:** jalankan dengan `PORT=4173 npm start`.
- **Playlist privat tidak dimuat:** set `SUNO_TOKEN` di environment server.
- **Cache offline atau push tidak tersedia:** pastikan aplikasi dibuka di `localhost` atau melalui HTTPS.
- **PIN awal tidak berfungsi:** file `admin-pins.json` mungkin sudah menyimpan PIN lain. Gunakan PIN yang terakhir diatur dari panel.
- **Notifikasi push gagal:** atur `VAPID_SUBJECT` dengan alamat kontak yang valid dan pastikan server tetap menggunakan `web-push-keys.json` yang sama.

## Catatan

Suno dapat mengubah API atau format audionya, sehingga pemutaran dapat terpengaruh. Hormati ketentuan Suno dan hak pemilik musik.
