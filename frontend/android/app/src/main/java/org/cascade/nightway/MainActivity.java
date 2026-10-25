package org.cascade.nightway;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import org.cascade.nightway.mesh.MeshPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MeshPlugin.class);   // real Bluetooth relay (Phase 7); off until switched on in the Demo drawer
        super.onCreate(savedInstanceState);
    }
}
