namespace Game.Core
{
    public class WeatherSystem
    {
        public void Rain() { }
    }

    public class SystemsHub
    {
        public WeatherSystem Weather;
    }

    public class GameRoot : UnityEngine.MonoBehaviour
    {
        public SystemsHub Systems { get; private set; }

        private void Update()
        {
            var hub = Systems;
            hub.Weather.Rain();
            Systems.Weather.Rain();
        }
    }
}
