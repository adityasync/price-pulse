const { createClient } = require('@supabase/supabase-js');

// Service-role key — backend only, never exposed to the frontend.
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.warn('[db] SUPABASE_URL / SUPABASE_SERVICE_KEY not set — DB calls will fail until .env is filled.');
}

const supabase = createClient(url || 'http://localhost:0', key || 'missing-key');

module.exports = { supabase };
