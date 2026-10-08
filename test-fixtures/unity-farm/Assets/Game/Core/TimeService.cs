using System;

namespace Game.Core
{
    public interface ITimeService
    {
        float Now { get; }
        event Action<float> OnTick;
    }

    public class TimeService : ITimeService
    {
        public float Now => _now;
        private float _now;
        public event Action<float> OnTick;

        public void Advance(float dt)
        {
            _now += dt;
            OnTick?.Invoke(_now);
        }
    }
}
