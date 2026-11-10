// Keep npm start portable to cmd.exe, PowerShell and POSIX shells.
process.env.NODE_ENV = 'production';
await import('../server/index.js');
export {};
