package it.casa.irremote;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.hardware.ConsumerIrManager;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;

/**
 * Phone IR blaster + phone-side schedules (for codes the S18 cannot send, e.g. Gree AC).
 * Schedules are JSON: [{id, h, m, days (bit0 = Sunday), patterns: [{freq, pattern: [µs...]}]}].
 * The same class is the alarm/boot receiver, so the alarm survives the app being closed.
 */
public class PhoneIr extends BroadcastReceiver {
    private static final String PREFS = "phone_ir", KEY = "schedules", TAG = "PhoneIr";

    static boolean available(Context c) {
        ConsumerIrManager ir = (ConsumerIrManager) c.getSystemService(Context.CONSUMER_IR_SERVICE);
        return ir != null && ir.hasIrEmitter();
    }

    /** Returns "" on success, otherwise the error text. */
    static String transmit(Context c, int freq, int[] pattern) {
        try {
            ConsumerIrManager ir = (ConsumerIrManager) c.getSystemService(Context.CONSUMER_IR_SERVICE);
            if (ir == null || !ir.hasIrEmitter()) return "nessun emettitore IR";
            ir.transmit(freq, pattern);
            return "";
        } catch (Exception e) {
            return String.valueOf(e.getMessage());
        }
    }

    static int[] toInts(JSONArray a) {
        int[] p = new int[a.length()];
        for (int i = 0; i < p.length; i++) p[i] = a.optInt(i);
        return p;
    }

    static void saveSchedules(Context c, String json) {
        c.getSharedPreferences(PREFS, 0).edit().putString(KEY, json).apply();
        rescheduleAll(c);
    }

    static void rescheduleAll(Context c) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        SharedPreferences sp = c.getSharedPreferences(PREFS, 0);
        int old = sp.getInt("count", 0);
        for (int i = 0; i < old; i++) am.cancel(pending(c, i)); // drop alarms of removed schedules
        try {
            JSONArray list = new JSONArray(sp.getString(KEY, "[]"));
            for (int i = 0; i < list.length(); i++) schedule(c, am, i, list.getJSONObject(i));
            sp.edit().putInt("count", list.length()).apply();
        } catch (Exception e) {
            Log.e(TAG, "bad schedules", e);
        }
    }

    private static PendingIntent pending(Context c, int index) {
        Intent i = new Intent(c, PhoneIr.class).setAction("it.casa.irremote.FIRE").putExtra("index", index);
        return PendingIntent.getBroadcast(c, index, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void schedule(Context c, AlarmManager am, int index, JSONObject s) {
        int days = s.optInt("days", 0x7F);
        if (days == 0) return;
        Calendar t = Calendar.getInstance();
        t.set(Calendar.SECOND, 0);
        t.set(Calendar.MILLISECOND, 0);
        t.set(Calendar.HOUR_OF_DAY, s.optInt("h"));
        t.set(Calendar.MINUTE, s.optInt("m"));
        for (int k = 0; k < 8; k++) { // next enabled weekday, today included if still ahead
            int dow = t.get(Calendar.DAY_OF_WEEK) - 1; // 0 = Sunday
            if ((days & (1 << dow)) != 0 && t.getTimeInMillis() > System.currentTimeMillis() + 1000) break;
            t.add(Calendar.DAY_OF_MONTH, 1);
        }
        PendingIntent pi = pending(c, index);
        if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t.getTimeInMillis(), pi);
        } else {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t.getTimeInMillis(), pi);
        }
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        String action = intent.getAction();
        if (!"it.casa.irremote.FIRE".equals(action)) { // boot / app update
            rescheduleAll(c);
            return;
        }
        PendingResult res = goAsync();
        new Thread(() -> {
            try {
                JSONArray list = new JSONArray(c.getSharedPreferences(PREFS, 0).getString(KEY, "[]"));
                int idx = intent.getIntExtra("index", -1);
                if (idx >= 0 && idx < list.length()) {
                    JSONArray pats = list.getJSONObject(idx).optJSONArray("patterns");
                    for (int i = 0; pats != null && i < pats.length(); i++) {
                        JSONObject p = pats.getJSONObject(i);
                        String err = transmit(c, p.optInt("freq", 38000), toInts(p.getJSONArray("pattern")));
                        if (!err.isEmpty()) Log.e(TAG, err);
                        Thread.sleep(400);
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "fire failed", e);
            } finally {
                rescheduleAll(c); // arm the next occurrence
                res.finish();
            }
        }).start();
    }
}
