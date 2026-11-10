import 'dotenv/config';
import { createLocalWeChatTransport } from '../server/wechat-transport.js';

const { account_key: _private, ...status } = await createLocalWeChatTransport().status();
console.log(JSON.stringify(status, null, 2));
